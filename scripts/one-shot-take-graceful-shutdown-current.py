from pathlib import Path
import re


def replace_once(path: str, old: str, new: str, label: str) -> None:
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: {label}: expected one match, found {count}')
    target.write_text(text.replace(old, new, 1))


def replace_between(path: str, start: str, end: str, new: str, label: str) -> None:
    target = Path(path)
    text = target.read_text()
    start_index = text.find(start)
    if start_index < 0:
        raise SystemExit(f'{path}: {label}: start marker not found')
    end_index = text.find(end, start_index)
    if end_index < 0:
        raise SystemExit(f'{path}: {label}: end marker not found')
    if text.find(start, start_index + 1) >= 0:
        raise SystemExit(f'{path}: {label}: start marker is not unique')
    target.write_text(text[:start_index] + new + text[end_index:])


# The original one-shot migration predates durable Take history and the
# sample-count consistency check now present in TakeController. Adapt only that
# controller seam while preserving the migration's remaining source/test edits.
replace_once(
    'src/take-controller.ts',
    """  private storagePrepared = false;\n  private pruneChain: Promise<void> = Promise.resolve();\n""",
    """  private storagePrepared = false;\n  private pruneChain: Promise<void> = Promise.resolve();\n  private finalization: Promise<void> | null = null;\n""",
    'track in-flight WAV finalization',
)

replace_once(
    'src/take-controller.ts',
    """  shutdown() {\n    const writer = this.writer;\n    this.writer = null;\n    this.quality = null;\n    this.pendingStop = null;\n    if (writer) void writer.abort();\n  }\n""",
    """  async shutdown(nowMs = Date.now()) {\n    const current = this.session.currentTake();\n    if (current?.lifecycle === 'recording' && current.mixSampleRange) {\n      this.quality?.noteEvent('server-shutdown');\n      const request: PendingStop = {\n        takeId: current.takeId,\n        actorParticipantId: null,\n        stopReason: 'server-shutdown',\n        stopPosition: {\n          generation: current.mixSampleRange.generation,\n          firstSampleIndex: current.mixSampleRange.endSampleIndex,\n        },\n        endedAtMs: nowMs,\n      };\n      this.pendingStop = request;\n      this.finalizeStop(request);\n    }\n\n    const finalization = this.finalization;\n    if (finalization) await finalization;\n\n    // A normal recording/finalizing Take is drained above. This fallback only\n    // covers a failed or internally inconsistent writer lifecycle.\n    const orphanWriter = this.writer;\n    this.writer = null;\n    this.quality = null;\n    this.pendingStop = null;\n    if (orphanWriter) await orphanWriter.abort();\n    await this.pruneChain;\n  }\n""",
    'drain recording/finalizing Take before process shutdown',
)

replace_between(
    'src/take-controller.ts',
    "    void writer.finalize()\n",
    "    return decision;\n  }\n\n  private failWriter",
    """    const finalization = this.finalizeWriter(writer, request.takeId);\n    this.finalization = finalization;\n    void finalization.then(() => {\n      if (this.finalization === finalization) this.finalization = null;\n    });\n\n""",
    'make current Take finalization awaitable',
)

replace_once(
    'src/take-controller.ts',
    "  private failWriter(writer: WavTakeWriter, error: unknown) {\n",
    """  private async finalizeWriter(writer: WavTakeWriter, takeId: string) {\n    try {\n      const file = await writer.finalize();\n      const pendingTake = this.session.currentTake();\n      const recordedSampleCount = pendingTake?.mixSampleRange?.sampleCount ?? 0;\n      if (recordedSampleCount !== file.sampleCount) {\n        if (this.session.fail(\n          takeId,\n          `Take sample metadata recorded ${recordedSampleCount} samples but WAV contains ${file.sampleCount}.`,\n          Date.now(),\n        )) this.emitChange();\n        await writer.discardFinalized();\n        return;\n      }\n\n      const base = this.options.artifactBaseUrl ?? '/takes';\n      const completed = this.session.complete(takeId, {\n        fileName: file.fileName,\n        url: `${base}/${encodeURIComponent(takeId)}.wav`,\n        mimeType: 'audio/wav',\n        sizeBytes: file.sizeBytes,\n        sampleRate: file.sampleRate,\n        channels: 1,\n        bitsPerSample: 16,\n        sampleCount: file.sampleCount,\n        durationMs: file.durationMs,\n      });\n      if (completed) {\n        const readyTake = this.session.currentTake();\n        if (readyTake?.lifecycle === 'ready' && readyTake.artifact) {\n          try {\n            const item = historyItem(this.library.record(readyTake));\n            this.historyCache = Object.freeze([\n              structuredClone(item),\n              ...this.historyCache\n                .filter((candidate) => candidate.takeId !== item.takeId)\n                .map((candidate) => structuredClone(candidate)),\n            ]);\n          } catch (error) {\n            // The finalized WAV remains authoritative and recoverable. A\n            // metadata failure must not turn a successfully recorded Take\n            // into a failed one; the browser receives the ready Take beside\n            // the last durable history snapshot and can review it now.\n            this.reportStorageError(error);\n          }\n        }\n        this.emitChange();\n        this.scheduleRetentionPrune();\n      } else {\n        await writer.discardFinalized();\n      }\n    } catch (error) {\n      if (this.session.fail(takeId, errorMessage(error), Date.now())) this.emitChange();\n      await writer.abort();\n    }\n  }\n\n  private failWriter(writer: WavTakeWriter, error: unknown) {\n""",
    'preserve current finalization contracts in awaitable helper',
)

migration_path = Path('scripts/one-shot-take-graceful-shutdown.py')
migration_source = migration_path.read_text()
controller_call = re.compile(
    r"\nreplace_once\(\n    'src/take-controller\\.ts',\n.*?\n\)\n",
    re.DOTALL,
)
migration_source, removed = controller_call.subn('\n', migration_source)
if removed != 3:
    raise SystemExit(f'expected three stale TakeController migration blocks, removed {removed}')

exec(compile(migration_source, str(migration_path), 'exec'), {'__name__': '__main__'})

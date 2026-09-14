from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected one match, found {count}')
    p.write_text(text.replace(old, new, 1))

# AudioSession: source rate is part of Backing capture-clock identity.
replace_once(
    'src/audio-session.ts',
    """    return this.ingest(this.backing, frame, sourceRate, nowMs, trackSourceClock);\n""",
    """    return this.ingest(\n      this.backing,\n      frame,\n      sourceRate,\n      nowMs,\n      trackSourceClock,\n      true,\n    );\n""",
)

# Backing coordinator: consume AudioSession's canonical restart signal as well as
# the historical generation comparison.
replace_once(
    'src/relay-audio-uplink-coordinator.ts',
    """  ingestBacking(frame: PcmFrame, nowMs: number): {\n    samples: Int16Array;\n    start: number;\n  };\n""",
    """  ingestBacking(frame: PcmFrame, nowMs: number): {\n    samples: Int16Array;\n    start: number;\n    captureRestarted: boolean;\n  };\n""",
)
replace_once(
    'src/relay-audio-uplink-coordinator.ts',
    """      const { samples, start } = options.ingestBacking(frame, nowMs);\n      if (samples.length > 0) options.noteBackingFrame(socket, nowMs);\n      if (\n        previousGeneration !== null\n        && options.backingGeneration() !== previousGeneration\n      ) {\n        options.onBackingCaptureRestarted();\n      }\n""",
    """      const { samples, start, captureRestarted } = options.ingestBacking(frame, nowMs);\n      if (samples.length > 0) options.noteBackingFrame(socket, nowMs);\n      if (\n        captureRestarted\n        || (\n          previousGeneration !== null\n          && options.backingGeneration() !== previousGeneration\n        )\n      ) {\n        options.onBackingCaptureRestarted();\n      }\n""",
)

# Calibration context: include the source-clock units that make generation
# meaningful. Optional keeps existing fixture literals source-compatible; all
# production contexts populate these fields in server.ts.
replace_once(
    'src/calibration-session.ts',
    """export type CalibrationContext = {\n  sessionGeneration: number;\n  micGeneration: number | null;\n  backingGeneration: number | null;\n  sourceGeneration: number;\n};\n""",
    """export type CalibrationContext = {\n  sessionGeneration: number;\n  micGeneration: number | null;\n  backingGeneration: number | null;\n  /** Source-clock units for the Mic capture generation. */\n  micSourceRate?: number | null;\n  /** Source-clock units for the Backing capture generation. */\n  backingSourceRate?: number | null;\n  sourceGeneration: number;\n};\n""",
)
replace_once(
    'src/calibration-session.ts',
    """    return this.measuredContext.sessionGeneration !== context.sessionGeneration\n      || this.measuredContext.micGeneration !== context.micGeneration\n      || this.measuredContext.backingGeneration !== context.backingGeneration\n      || this.measuredContext.sourceGeneration !== context.sourceGeneration;\n""",
    """    return this.measuredContext.sessionGeneration !== context.sessionGeneration\n      || this.measuredContext.micGeneration !== context.micGeneration\n      || this.measuredContext.backingGeneration !== context.backingGeneration\n      || (this.measuredContext.micSourceRate ?? null) !== (context.micSourceRate ?? null)\n      || (this.measuredContext.backingSourceRate ?? null) !== (context.backingSourceRate ?? null)\n      || this.measuredContext.sourceGeneration !== context.sourceGeneration;\n""",
)
replace_once(
    'src/calibration-session.ts',
    """    return left.sessionGeneration === right.sessionGeneration\n      && left.micGeneration === right.micGeneration\n      && left.backingGeneration === right.backingGeneration\n      && left.sourceGeneration === right.sourceGeneration;\n""",
    """    return left.sessionGeneration === right.sessionGeneration\n      && left.micGeneration === right.micGeneration\n      && left.backingGeneration === right.backingGeneration\n      && (left.micSourceRate ?? null) === (right.micSourceRate ?? null)\n      && (left.backingSourceRate ?? null) === (right.backingSourceRate ?? null)\n      && left.sourceGeneration === right.sourceGeneration;\n""",
)

for path in ['src/content-calibration-validator.ts', 'src/robot-content-timeline.ts']:
    replace_once(
        path,
        """    && a.micGeneration === b.micGeneration\n    && a.backingGeneration === b.backingGeneration\n    && a.sourceGeneration === b.sourceGeneration;\n""" if 'content-calibration' in path else """    && left.micGeneration === right.micGeneration\n    && left.backingGeneration === right.backingGeneration\n    && left.sourceGeneration === right.sourceGeneration;\n""",
        """    && a.micGeneration === b.micGeneration\n    && a.backingGeneration === b.backingGeneration\n    && (a.micSourceRate ?? null) === (b.micSourceRate ?? null)\n    && (a.backingSourceRate ?? null) === (b.backingSourceRate ?? null)\n    && a.sourceGeneration === b.sourceGeneration;\n""" if 'content-calibration' in path else """    && left.micGeneration === right.micGeneration\n    && left.backingGeneration === right.backingGeneration\n    && (left.micSourceRate ?? null) === (right.micSourceRate ?? null)\n    && (left.backingSourceRate ?? null) === (right.backingSourceRate ?? null)\n    && left.sourceGeneration === right.sourceGeneration;\n""",
    )

# Robot content transition has its own structurally-equivalent context type.
replace_once(
    'src/robot-content-transition-runtime.ts',
    """export type RobotContentTransitionContext = {\n  sessionGeneration: number;\n  micGeneration: number | null;\n  backingGeneration: number | null;\n  sourceGeneration: number;\n};\n""",
    """export type RobotContentTransitionContext = {\n  sessionGeneration: number;\n  micGeneration: number | null;\n  backingGeneration: number | null;\n  micSourceRate?: number | null;\n  backingSourceRate?: number | null;\n  sourceGeneration: number;\n};\n""",
)
replace_once(
    'src/robot-content-transition-runtime.ts',
    """  return left.sessionGeneration === right.sessionGeneration\n    && left.micGeneration === right.micGeneration\n    && left.backingGeneration === right.backingGeneration\n    && left.sourceGeneration === right.sourceGeneration;\n""",
    """  return left.sessionGeneration === right.sessionGeneration\n    && left.micGeneration === right.micGeneration\n    && left.backingGeneration === right.backingGeneration\n    && (left.micSourceRate ?? null) === (right.micSourceRate ?? null)\n    && (left.backingSourceRate ?? null) === (right.backingSourceRate ?? null)\n    && left.sourceGeneration === right.sourceGeneration;\n""",
)

# Boot probe has a separate two-leg provenance model. Completed authority binds
# both rates; the stored Mic leg only binds the Mic rate.
replace_once(
    'src/boot-probe-runtime.ts',
    """export type BootProbeContext = {\n  sessionGeneration: number;\n  micGeneration: number | null;\n  backingGeneration: number | null;\n};\n\nexport type BootProbeMicLeg = {\n  targetSample: number;\n  actualSample: number;\n  correlation: number;\n  sessionGeneration: number;\n  micGeneration: number | null;\n};\n""",
    """export type BootProbeContext = {\n  sessionGeneration: number;\n  micGeneration: number | null;\n  backingGeneration: number | null;\n  micSourceRate?: number | null;\n  backingSourceRate?: number | null;\n};\n\nexport type BootProbeMicLeg = {\n  targetSample: number;\n  actualSample: number;\n  correlation: number;\n  sessionGeneration: number;\n  micGeneration: number | null;\n  micSourceRate?: number | null;\n};\n""",
)
replace_once(
    'src/boot-probe-runtime.ts',
    """type BootProbeMicLegContext = Pick<BootProbeContext, 'sessionGeneration' | 'micGeneration'>;\n\nfunction micLegMatchesContext(leg: BootProbeMicLeg, context: BootProbeMicLegContext) {\n  return leg.sessionGeneration === context.sessionGeneration\n    && leg.micGeneration === context.micGeneration;\n}\n""",
    """type BootProbeMicLegContext = Pick<\n  BootProbeContext,\n  'sessionGeneration' | 'micGeneration' | 'micSourceRate'\n>;\n\nfunction micLegMatchesContext(leg: BootProbeMicLeg, context: BootProbeMicLegContext) {\n  return leg.sessionGeneration === context.sessionGeneration\n    && leg.micGeneration === context.micGeneration\n    && (leg.micSourceRate ?? null) === (context.micSourceRate ?? null);\n}\n""",
)
replace_once(
    'src/boot-probe-runtime.ts',
    """    return this.completedContext !== null\n      && this.completedContext.sessionGeneration === context.sessionGeneration\n      && this.completedContext.micGeneration === context.micGeneration\n      && this.completedContext.backingGeneration === context.backingGeneration;\n""",
    """    return this.completedContext !== null\n      && this.completedContext.sessionGeneration === context.sessionGeneration\n      && this.completedContext.micGeneration === context.micGeneration\n      && this.completedContext.backingGeneration === context.backingGeneration\n      && (this.completedContext.micSourceRate ?? null) === (context.micSourceRate ?? null)\n      && (this.completedContext.backingSourceRate ?? null) === (context.backingSourceRate ?? null);\n""",
)

# Production context constructors bind runtime source rates to the generation.
replace_once(
    'src/server.ts',
    """    sessionGeneration: session.generation,\n    micGeneration: session.micGeneration,\n    backingGeneration: session.backingGeneration,\n    sourceGeneration: sourceRuntime.generation,\n""",
    """    sessionGeneration: session.generation,\n    micGeneration: session.micGeneration,\n    backingGeneration: session.backingGeneration,\n    micSourceRate: micRuntime.sampleRate,\n    backingSourceRate: backingRuntime.sampleRate,\n    sourceGeneration: sourceRuntime.generation,\n""",
)
replace_once(
    'src/server.ts',
    """function bootProbeContext() {\n  return {\n    sessionGeneration: session.generation,\n    micGeneration: session.micGeneration,\n    backingGeneration: session.backingGeneration,\n  };\n}\n""",
    """function bootProbeContext() {\n  return {\n    sessionGeneration: session.generation,\n    micGeneration: session.micGeneration,\n    backingGeneration: session.backingGeneration,\n    micSourceRate: micRuntime.sampleRate,\n    backingSourceRate: backingRuntime.sampleRate,\n  };\n}\n""",
)
replace_once(
    'src/server.ts',
    """      sessionGeneration: session.generation,\n      micGeneration: analysis.generation,\n    });\n""",
    """      sessionGeneration: session.generation,\n      micGeneration: analysis.generation,\n      micSourceRate: micRuntime.sampleRate,\n    });\n""",
)

print('patched capture rate into timing context identity')

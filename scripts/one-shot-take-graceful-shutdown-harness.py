from pathlib import Path

path = Path('test/helpers/harness.ts')
text = path.read_text()
old = """    child.once('exit', (code) => {\n      clearTimeout(timer);\n      reject(new Error(`Relay exited early with code ${code}.\\n${stdout}\\n${stderr}`));\n    });\n\n    child.stdout.setEncoding('utf8');\n    child.stdout.on('data', (chunk: string) => {\n      stdout += chunk;\n      const match = stdout.match(/listening on http:\\/\\/localhost:(\\d+)/);\n      if (!match) return;\n\n      clearTimeout(timer);\n      child.removeAllListeners('exit');\n      const port = Number(match[1]);\n"""
new = """    const onEarlyExit = (code: number | null) => {\n      clearTimeout(timer);\n      reject(new Error(`Relay exited early with code ${code}.\\n${stdout}\\n${stderr}`));\n    };\n    child.once('exit', onEarlyExit);\n\n    let started = false;\n    child.stdout.setEncoding('utf8');\n    child.stdout.on('data', (chunk: string) => {\n      stdout += chunk;\n      if (started) return;\n      const match = stdout.match(/listening on http:\\/\\/localhost:(\\d+)/);\n      if (!match) return;\n\n      started = true;\n      clearTimeout(timer);\n      child.off('exit', onEarlyExit);\n      const port = Number(match[1]);\n"""
if text.count(old) != 1:
    raise SystemExit(f'test/helpers/harness.ts: expected one startup lifecycle block, found {text.count(old)}')
path.write_text(text.replace(old, new, 1))

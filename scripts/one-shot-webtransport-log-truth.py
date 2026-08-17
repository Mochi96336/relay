from pathlib import Path


def replace_once(path: str, old: str, new: str, label: str) -> None:
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: {label}: expected one match, found {count}')
    target.write_text(text.replace(old, new, 1))


replace_once(
    'src/webtransport-media-server.ts',
    """export type WebTransportMediaServer = {\n  offer(ticket: string): WebTransportMediaOffer | undefined;\n""",
    """export type WebTransportMediaServer = {\n  available: boolean;\n  offer(ticket: string): WebTransportMediaOffer | undefined;\n""",
    'expose direct-media availability',
)

replace_once(
    'src/webtransport-media-server.ts',
    """  return {\n    offer() {\n      return undefined;\n""",
    """  return {\n    available: false,\n    offer() {\n      return undefined;\n""",
    'mark fallback adapter unavailable',
)

replace_once(
    'src/webtransport-media-server.ts',
    """  return {\n    offer(ticket) {\n      return offerFor(config, ticket, certificateHash);\n""",
    """  return {\n    available: true,\n    offer(ticket) {\n      return offerFor(config, ticket, certificateHash);\n""",
    'mark configured adapter available',
)

replace_once(
    'src/server.ts',
    """    console.log(\n      `Relay WebTransport media listening on udp://${directMediaConfig.bindHost}:${directMediaConfig.bindPort}`\n      + ` and advertised as ${directMediaConfig.publicUrl.toString()}`,\n    );\n""",
    """    if (webTransportMedia.available) {\n      console.log(\n        `Relay WebTransport media listening on udp://${directMediaConfig.bindHost}:${directMediaConfig.bindPort}`\n        + ` and advertised as ${directMediaConfig.publicUrl.toString()}`,\n      );\n    }\n""",
    'guard listening success log by actual startup',
)

replace_once(
    'test/webtransport-media-server.test.ts',
    """    assert.equal(media.offer('ticket'), undefined);\n    assert.equal(media.hasSession('ticket'), false);\n""",
    """    assert.equal(media.available, false);\n    assert.equal(media.offer('ticket'), undefined);\n    assert.equal(media.hasSession('ticket'), false);\n""",
    'assert failed startup is observable as unavailable',
)

replace_once(
    'test/webtransport-media-server.test.ts',
    """it('retires direct-media authority at every Mic ownership terminal boundary', () => {\n  const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');\n""",
    """it('logs direct-media listening only when HTTP/3 actually started', () => {\n  const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');\n\n  assert.match(\n    server,\n    /if \\(webTransportMedia\\.available\\) \\{[\\s\\S]{0,300}Relay WebTransport media listening/ ,\n    'the no-op fallback must not emit a false listening success message',\n  );\n});\n\nit('retires direct-media authority at every Mic ownership terminal boundary', () => {\n  const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');\n""",
    'pin truthful server logging',
)

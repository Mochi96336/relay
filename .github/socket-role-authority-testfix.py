from pathlib import Path

path = Path('test/socket-role-authority.test.ts')
text = path.read_text()

replacements = [
    (
        """    observer.send({ type: 'source-seeked' });
    await sleep(40);
    observer.send({ type: 'timing-calibration-status-request' });
    const untouched = await observer.waitFor(
      (message) => message.type === 'timing-calibration-status' && Math.round(message.robotPlayerOffsetMs) === 37,
    );
""",
        """    observer.send({ type: 'source-seeked' });
    await sleep(40);
    const untouchedFrom = observer.messages.length;
    observer.send({ type: 'timing-calibration-status-request' });
    const untouched = await waitForNewMessage(
      observer,
      untouchedFrom,
      (message) => message.type === 'timing-calibration-status' && Math.round(message.robotPlayerOffsetMs) === 37,
    );
""",
    ),
    (
        """    desktopSource.send({ type: 'source-seeked' });
    await sleep(40);
    observer.send({ type: 'timing-calibration-status-request' });
    const stillRobot = await observer.waitFor(
      (message) => message.type === 'timing-calibration-status' && Math.round(message.robotPlayerOffsetMs) === 37,
    );
""",
        """    desktopSource.send({ type: 'source-seeked' });
    await sleep(40);
    const stillRobotFrom = observer.messages.length;
    observer.send({ type: 'timing-calibration-status-request' });
    const stillRobot = await waitForNewMessage(
      observer,
      stillRobotFrom,
      (message) => message.type === 'timing-calibration-status' && Math.round(message.robotPlayerOffsetMs) === 37,
    );
""",
    ),
    (
        """    robot.send({ type: 'source-seeked' });
    await sleep(40);
    observer.send({ type: 'timing-calibration-status-request' });
    const cleared = await observer.waitFor(
      (message) => message.type === 'timing-calibration-status' && message.robotPlayerOffsetMs === null,
    );
""",
        """    robot.send({ type: 'source-seeked' });
    await sleep(40);
    const clearedFrom = observer.messages.length;
    observer.send({ type: 'timing-calibration-status-request' });
    const cleared = await waitForNewMessage(
      observer,
      clearedFrom,
      (message) => message.type === 'timing-calibration-status' && message.robotPlayerOffsetMs === null,
    );
""",
    ),
]

for old, new in replacements:
    if text.count(old) != 1:
        raise SystemExit('socket-role test hardening: expected one exact match')
    text = text.replace(old, new, 1)

path.write_text(text)

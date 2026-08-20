/**
 * An observer that merely selected a Song must never restore media locally
 * when the remote playback target finishes or fails. Restoration belongs to
 * the exact page that applied the command, or to a non-observer holder whose
 * native YouTube control already changed before server authorization.
 */
export function shouldRestoreRoomAfterCommandTerminal({
  role,
  trackedCommandId,
  appliedCommandId,
}) {
  if (typeof trackedCommandId !== 'string' || trackedCommandId.length === 0) return false;
  if (role !== 'observer') return true;
  return appliedCommandId === trackedCommandId;
}

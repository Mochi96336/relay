export function shouldRequestAudioResume(state) {
  return state === 'suspended' || state === 'interrupted';
}

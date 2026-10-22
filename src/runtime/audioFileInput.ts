/** Accept string already used by the local audio upload control. */
export const AUDIO_FILE_ACCEPT = 'audio/*';

/**
 * Read the first selected file in the browser. Returns null during SSR and
 * when the picker is empty. The existing upload path still accepts the file
 * the browser provides; this helper does not add a new rejection rule.
 */
export function readSelectedAudioFile(files: FileList | readonly File[] | null | undefined): File | null {
  if (typeof File === 'undefined' || !files || files.length === 0) {
    return null;
  }

  return files[0] ?? null;
}

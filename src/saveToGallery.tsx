export function saveToGallery(
  _path: string,
  _mimeType: string,
  _displayName?: string
): Promise<string> {
  throw new Error(
    "'react-native-facefusion' is only supported on native platforms."
  );
}

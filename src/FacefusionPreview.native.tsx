import { requireNativeComponent } from 'react-native';
import type { ViewProps } from 'react-native';

export type FacefusionPreviewProps = ViewProps;

/**
 * A live view of the frame [swapPhoto]/[swapVideo] just produced — the result the instant
 * it's ready for a photo, and one frame at a time while a video swap is running.
 *
 * No prop carries pixels and none of this crosses the JS bridge: the native side
 * (`PreviewSurfaceHolder.kt`) draws straight into this view's own `Surface` from whichever
 * swap is running. Mount it, give it a size with `style`, and it shows whatever the native
 * layer is currently drawing — there is nothing else to wire up. At most one swap runs at a
 * time (`PipeGuard`), so at most one `<FacefusionPreview />` needs to be mounted to see it.
 */
export const FacefusionPreview = requireNativeComponent<FacefusionPreviewProps>(
  'FacefusionPreviewView'
);

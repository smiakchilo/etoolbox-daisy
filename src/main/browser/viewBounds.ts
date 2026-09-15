import type { Rectangle } from 'electron';
import type { ViewBounds } from '../../shared/browser-ipc';

/**
 * Clamps a renderer-reported `.browser-view-host` rectangle to the window's
 * actual content bounds before it is ever handed to
 * `WebContentsView.setBounds`.
 *
 * The renderer's own `ResizeObserver`-driven bounds report
 * (`browser:set-view-bounds`) is normally accurate, but it is still an
 * untrusted cross-process message: a stale message delivered after a rapid
 * resize, or a future renderer bug, could report a rectangle that extends
 * past the window's current content area. Positioning a `WebContentsView`
 * partly or fully outside the window does not fail loudly - Chromium simply
 * renders (and still accepts input for) the overhanging portion off-window,
 * which is a confusing, hard-to-notice state rather than a crash. Clamping
 * here means the AEM view can never visually or interactively escape the
 * window, regardless of what the IPC message contains.
 */
export function clampViewBounds(bounds: ViewBounds, container: Rectangle): Rectangle {
  const x = Math.min(Math.max(bounds.x, 0), container.width);
  const y = Math.min(Math.max(bounds.y, 0), container.height);
  const maxWidth = Math.max(container.width - x, 0);
  const maxHeight = Math.max(container.height - y, 0);
  return {
    x,
    y,
    width: Math.min(bounds.width, maxWidth),
    height: Math.min(bounds.height, maxHeight),
  };
}

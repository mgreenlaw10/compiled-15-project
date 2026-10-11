/**
 * The visual vocabulary of the app.
 *
 * Deliberately plain: no component library, so every screen is built from
 * these few elements plus the stylesheets in `../styles`. Anything used by
 * more than one feature belongs here; anything used by one belongs in that
 * feature's folder.
 */

export { Badge } from './Badge'
export { Banner, type BannerKind } from './Banner'
export { DiffBlock } from './DiffBlock'
export { Checkbox, Field, TextAreaField, TextField } from './fields'
export { formatTime, plural } from './format'
export { Empty, SectionTitle } from './layout'
export { Modal, type ModalProps } from './Modal'

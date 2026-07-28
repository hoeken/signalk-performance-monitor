/**
 * Copy text to the clipboard, returning whether it worked.
 *
 * `navigator.clipboard` only exists in secure contexts (HTTPS or
 * localhost), and a Signal K server on the boat network is typically
 * plain HTTP — so fall back to the legacy hidden-textarea +
 * `document.execCommand('copy')` path, which still works everywhere.
 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // permission denied or insecure context; try the legacy path
    }
  }
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    textarea.remove()
  }
}

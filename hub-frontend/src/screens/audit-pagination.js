export function validAuditPage(page, total, pageSize) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  return Math.min(page, pages)
}

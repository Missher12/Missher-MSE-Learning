/** Local natural-day key for the daily digest watermark (the host runs in the user's timezone). */
export const localDayKey = at => {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

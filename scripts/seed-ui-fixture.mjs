/**
 * Seed a synthetic MSE learning store for the isolated detail-page verification.
 *
 * `node scripts/seed-ui-fixture.mjs <state-root>`
 *
 * Content is deliberately synthetic and covers every state the page must render honestly:
 * live corrections (including a recognised preference slot and a negation), one validated
 * and one candidate method, one suspended rule, and two rows written with a past clock so
 * they read as expired. Nothing here touches a real installation.
 */
import { LearningEngine } from '../src/index.mjs'

const stateRoot = process.argv[2]
if (typeof stateRoot !== 'string' || stateRoot.length === 0) throw new Error('usage: seed-ui-fixture.mjs <state-root>')
const DAY = 86_400_000
const PAST = Date.now() - 200 * DAY

// Written with a past clock, so their 90-day window already closed.
const stale = new LearningEngine({ stateRoot, adapterId: 'dsh', now: () => PAST })
for (const [index, text] of ['以后报表页脚使用宋体小五号', '以后报表附录按章节编号排序'].entries()) {
  stale.prepare({ sessionId: `stale-${index}`, turnId: '1', origin: 'user', prompt: `记住：${text}` })
}

const engine = new LearningEngine({ stateRoot, adapterId: 'dsh' })
const corrections = [
  '以后导出报表金额时统一使用人民币',
  '以后不要把空值改成零，保留原始空值',
  '以后日志时间一律使用 UTC 时区并标注后缀',
  '以后提交信息用中文描述改动原因',
  '以后金额字段保留两位小数，不做四舍五入',
  '以后接口返回值不要用 null，用空数组或空字符串',
  '以后文件名使用短横线而不是下划线',
  '以后数据库迁移脚本必须可回滚',
  '以后配置项默认关闭新实验特性',
  '以后图表横轴统一按自然日排序',
  '以后错误信息里不要包含用户路径',
  '以后导出 CSV 使用 UTF-8 BOM',
]
for (const [index, text] of corrections.entries()) {
  engine.prepare({ sessionId: `seed-${index}`, turnId: '1', origin: 'user', prompt: `记住：${text}` })
}
const registered = engine.record({ eventId: 'seed-method-registered', kind: 'method', source: 'host_proposal',
  methodId: 'numeric-sort-v1' })
engine.evaluateRegistered({ lessonId: registered.id })
engine.record({ eventId: 'seed-method-candidate', kind: 'method', source: 'host_proposal',
  instruction: '按来源日期覆盖目标日期后再比较版本号，只有来源更新时才写入。',
  applicability: '多来源日期字段合并写入时', exclusions: '来源日期缺失或格式无法解析' })
const suspended = engine.prepare({ sessionId: 'seed-suspended', turnId: '1', origin: 'user',
  prompt: '记住：以后图表配色一律使用冷色系' }).learned
if (suspended?.id !== undefined) engine.suspend({ lessonId: suspended.id })

const rows = engine.list({ limit: 100 }).lessons
console.log(JSON.stringify({ lessons: rows.length,
  statuses: rows.reduce((acc, row) => { acc[row.status] = (acc[row.status] ?? 0) + 1; return acc }, {}),
  kinds: rows.reduce((acc, row) => { acc[row.kind] = (acc[row.kind] ?? 0) + 1; return acc }, {}) }))

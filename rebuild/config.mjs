/**
 * Slim editable settings for the rebuilt chain — the same schemastery pattern the released bundle
 * uses (Cordis reads the validator off the plugin object; `.volatile()` fields are live reads).
 * The settings route, when filled, is an explicit operator override. Left empty, background work
 * uses the route the HOST reported for the session that actually produced the work (failure
 * origin / the summarized day's fact owner) — bound per problem, never a newest-unrelated session.
 * `reflectionEnabled` keeps the released bundle's switch name so an existing profile with
 * reflectionEnabled:false keeps reflection, revision and daily summaries OFF after the upgrade.
 */
import z from '@deepseek-ai/schemastery'

export const SETTINGS_DEFAULTS = Object.freeze({
  enabled: true,
  reflectionEnabled: true,
  modelProvider: '',
  modelId: '',
  reasoningEffort: '',
  maxContextBytes: 768,
  dailyHour: 23,
  wakeIntervalMs: 600_000,
})

export const Config = z.object({
  enabled: z.boolean().default(SETTINGS_DEFAULTS.enabled).volatile(),
  /** 原 bundle 的后台复盘开关：false 时复盘/修订/每日总结都不发起模型调用，也容许旧配置直接加载。 */
  reflectionEnabled: z.boolean().default(SETTINGS_DEFAULTS.reflectionEnabled).volatile(),
  /** 后台复盘/修订/日总结使用的模型路由：显式 provider + model，留空 = 不做任何模型调用。 */
  modelProvider: z.string().max(128).default('').volatile(),
  modelId: z.string().max(128).default('').volatile(),
  reasoningEffort: z.union([z.const(''), z.const('low'), z.const('medium'), z.const('high')])
    .default('').volatile(),
  maxContextBytes: z.number().min(128).max(1536).step(1).default(SETTINGS_DEFAULTS.maxContextBytes).volatile(),
  dailyHour: z.number().min(0).max(23).step(1).default(SETTINGS_DEFAULTS.dailyHour).volatile(),
  wakeIntervalMs: z.number().min(60_000).max(3_600_000).step(1).default(SETTINGS_DEFAULTS.wakeIntervalMs).volatile(),
})

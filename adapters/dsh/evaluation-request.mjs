import { createHash } from 'node:crypto'

/** Match the exact provider payload identity used by callEvaluationModel(). */
export function evaluationRequestHash({ route, system, prompt, maxTokens }) {
  const shape = { provider: route.provider, model: route.model,
    ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
    system, user: { role: 'user', content: [{ type: 'text', text: prompt }] }, maxTokens }
  return createHash('sha256').update(JSON.stringify(shape)).digest('hex')
}

/** Hash the objective plan's complete finite call set without storing prompt text. */
export function objectiveRequestHashes(pack, route, maxTokens) {
  if (pack === null || typeof pack !== 'object' || route === null || typeof route !== 'object'
    || typeof route.provider !== 'string' || typeof route.model !== 'string') return null
  const hashes = []
  for (const testCase of pack.cases ?? []) {
    for (const arm of ['baseline', 'candidate']) {
      const request = pack.arm(arm, testCase)
      hashes.push(evaluationRequestHash({ route, system: request.system, prompt: request.prompt, maxTokens }))
    }
  }
  for (const replay of pack.replayCases ?? []) {
    for (const role of ['bad', 'control']) {
      const prompt = role === 'bad' ? replay.badInput : replay.controlInput
      hashes.push(evaluationRequestHash({ route,
        system: `你是 package.json 结构修复器。只返回修复后的完整 JSON 对象，不要解释。方法：${pack.instruction}`,
        prompt, maxTokens }))
    }
  }
  return hashes.sort()
}

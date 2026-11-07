/** One operation vocabulary shared by task extraction, policy synthesis and persisted validation. */
export const OPERATION_IDS = new Set(['deploy', 'test', 'export', 'sort', 'convert', 'validate', 'filter',
  'query', 'dedup', 'format', 'retry', 'merge'])

export const ACTION_GROUPS = Object.freeze([
  {id: 'opbuild', forms: ['构建', '编译', 'build', 'compile']},
  {id: 'opcheck', forms: ['检查', '核对', '确认', 'check', 'inspect']},
  {id: 'opchoose', forms: ['谁为准', '哪个为准', '谁来决定', '该取谁', '如何确定', 'which is authoritative', 'who to trust']},
  {id: 'opdebug', forms: ['排查', '调试', '定位原因', '分析原因', '如何定位', 'debug', 'troubleshoot', 'diagnose']},
  {id: 'oprepair', forms: ['修复', '解决', '怎么办', '怎么处理', '如何处理', 'fix', 'repair']},
  {id: 'opcreate', forms: ['创建', '生成', 'create', 'generate']},
  {id: 'opedit', forms: ['修改', '编辑', '更新', '调整', 'edit', 'modify', 'update']},
  {id: 'opread', forms: ['读取', '解析', '查看', 'read', 'parse']},
  {id: 'opwrite', forms: ['写入', '保存', 'write', 'save']},
  {id: 'oprun', forms: ['运行', '执行', 'run', 'execute']},
  {id: 'optypecheck', forms: ['类型检查', '类型校验', 'typecheck', 'type-check']},
])

export const ADAPTIVE_TASK_OPERATION_IDS = Object.freeze([
  ...OPERATION_IDS, ...ACTION_GROUPS.map(group => group.id),
])

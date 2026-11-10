import test from 'node:test'
import assert from 'node:assert/strict'
import { developmentCheckIdForCommand, developmentCheckMatchesVerification,
  runDevelopmentChecker } from './checker.mjs'

const foreground = ({ exitCode, stdout = '', stderr = '', stdoutTruncated = false,
  stderrTruncated = false, ...extra } = {}) => ({
  isError: false,
  value: { kind: 'foreground', cwd: '/workspace', signal: null, timedOut: false, aborted: false,
    exitCode, stdout: { text: stdout, truncated: stdoutTruncated },
    stderr: { text: stderr, truncated: stderrTruncated }, ...extra },
})
const passOutput = '✔ actual assertion (1.393204ms)\nℹ tests 1\nℹ suites 0\nℹ pass 1\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 141.550563\n'
const failOutput = '✖ actual assertion (3.275887ms)\nℹ tests 1\nℹ suites 0\nℹ pass 0\nℹ fail 1\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 139.093086\n'
const skipOutput = '﹣ not executed (1.053956ms) # SKIP\nℹ tests 1\nℹ suites 0\nℹ pass 0\nℹ fail 0\nℹ cancelled 0\nℹ skipped 1\nℹ todo 0\nℹ duration_ms 150.818348\n'
const pytestPass = '.\n1 passed in 0.03s\n'
const pytestFail = 'F\n1 failed in 0.03s\n'

test('Node spec output distinguishes a real pass, real failure, and non-executed tests', () => {
  const pass = runDevelopmentChecker({ command: 'node --test pass.test.mjs', result: foreground({ exitCode: 0, stdout: passOutput }) })
  assert.equal(pass.status, 'pass')
  assert.equal(pass.checkId, 'node-test-runner-spec-v1')
  assert.deepEqual(pass.evidence, { kind: 'node_test_runner', tests: 1, passed: 1, failed: 0,
    skipped: 0, cancelled: 0, todo: 0 })
  assert.equal(runDevelopmentChecker({ command:
    '/Users/missher/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node --test pass.test.mjs',
  result: foreground({ exitCode: 0, stdout: passOutput }) }).status, 'pass',
  'the bundled Node binary is a direct runner, not a shell wrapper')
  assert.equal(runDevelopmentChecker({ command: 'node --test fail.test.mjs',
    result: foreground({ exitCode: 1, stdout: failOutput }) }).status, 'fail')
  assert.equal(runDevelopmentChecker({ command: 'node --test skip.test.mjs',
    result: foreground({ exitCode: 0, stdout: skipOutput }) }).status, 'unknown')
  assert.equal(runDevelopmentChecker({ command: 'node --test empty.test.mjs', result: foreground({
    exitCode: 0, stdout: passOutput.replaceAll('1', '0').replace('✔ actual assertion (0.393204ms)\n', ''),
  }) }).status, 'unknown')
})

test('commands and results must be an exact, complete foreground runner invocation', () => {
  for (const command of ['echo fake', 'node -e "console.log(1)"', 'node --test pass.test.mjs && echo done',
    'npx node --test pass.test.mjs', 'node --test --test-reporter=tap pass.test.mjs']) {
    assert.equal(runDevelopmentChecker({ command, result: foreground({ exitCode: 0, stdout: passOutput }) }).status,
      'unknown', command)
  }
  assert.equal(runDevelopmentChecker({ command: 'node --test pass.test.mjs', result: foreground({
    exitCode: 0, stdout: passOutput, stdoutTruncated: true,
  }) }).status, 'unknown')
  assert.equal(runDevelopmentChecker({ command: 'node --test pass.test.mjs', result: foreground({
    exitCode: 0, stdout: passOutput, stderr: 'extra output',
  }) }).status, 'unknown')
  assert.equal(runDevelopmentChecker({ command: 'node --test pass.test.mjs', result: foreground({
    exitCode: 0, stdout: passOutput, aborted: true,
  }) }).status, 'unknown')
})

test('stored verification commands must exactly match the observed supported invocation', () => {
  assert.equal(developmentCheckMatchesVerification('node --test checks.test.mjs',
    '/opt/runtime/bin/node --test checks.test.mjs'), true)
  assert.equal(developmentCheckMatchesVerification('tsc --noEmit -p tsconfig.json',
    './node_modules/.bin/tsc --noEmit -p tsconfig.json'), true)
  assert.equal(developmentCheckMatchesVerification('node --test checks.test.mjs',
    'node --test other.test.mjs'), false)
  assert.equal(developmentCheckMatchesVerification('node --test checks.test.mjs',
    'env node --test checks.test.mjs'), false)
  assert.equal(developmentCheckMatchesVerification('node-test-runner-spec-v1',
    'node --test unrelated.test.mjs'), true,
  'legacy internal check IDs stay readable for existing methods')
})

test('TypeScript noEmit requires a project or source input and actual compiler output shape', () => {
  const pass = runDevelopmentChecker({ command: 'tsc --noEmit --project tsconfig.json',
    result: foreground({ exitCode: 0 }) })
  assert.equal(pass.status, 'pass')
  assert.equal(pass.checkId, 'typescript-noemit-v1')
  assert.deepEqual(pass.evidence, { kind: 'typescript_noemit', diagnostics: 0 })
  const fail = runDevelopmentChecker({ command: 'tsc --noEmit src/main.ts', result: foreground({
    exitCode: 2, stdout: 'src/main.ts(2,3): error TS2322: Type \'number\' is not assignable to type \'string\'.\n',
  }) })
  assert.equal(fail.status, 'fail')
  assert.deepEqual(fail.evidence, { kind: 'typescript_noemit', diagnostics: 1 })
  assert.equal(runDevelopmentChecker({ command: './node_modules/.bin/tsc --noEmit -p tsconfig.json',
    result: foreground({ exitCode: 0 }) }).status, 'pass')
  for (const command of ['tsc --noEmit', 'tsc --version', 'tsc --project tsconfig.json',
    'tsc --noEmit --project tsconfig.json && echo done']) {
    assert.equal(runDevelopmentChecker({ command, result: foreground({ exitCode: 0 }) }).status,
      'unknown', command)
  }
})

test('pytest recognizes only a direct bounded invocation and a complete, outcome-matched summary', () => {
  const command = 'pytest -q --color=no tests/test_sample.py'
  const pass = runDevelopmentChecker({ command, result: foreground({ exitCode: 0, stdout: pytestPass }) })
  assert.equal(developmentCheckIdForCommand(command), 'pytest-summary-v1')
  assert.equal(pass.status, 'pass')
  assert.equal(pass.checkId, 'pytest-summary-v1')
  assert.deepEqual(pass.evidence, { kind: 'pytest', tests: 1, passed: 1, failed: 0,
    errors: 0, skipped: 0, xfailed: 0, xpassed: 0, deselected: 0 })
  assert.equal(runDevelopmentChecker({ command,
    result: foreground({ exitCode: 0, stdout: '.                                                                        [100%]\n1 passed in 0.03s\n' }) }).status,
  'pass', 'quiet progress and terminal summary agree')
  assert.equal(runDevelopmentChecker({ command: 'pytest --color=no tests/test_sample.py',
    result: foreground({ exitCode: 0,
      stdout: 'tests/test_sample.py .. [100%]\n2 passed in 0.03s\n' }) }).status,
  'pass', 'default file progress output agrees with the summary')
  assert.equal(runDevelopmentChecker({ command: 'pytest -q tests/test_sample.py',
    result: foreground({ exitCode: 0, stdout: 'F. [100%]\n2 passed in 0.03s\n' }) }).status,
  'unknown', 'a failing progress marker cannot agree with a passing summary')
  const fail = runDevelopmentChecker({ command: 'python3 -m pytest tests/test_sample.py',
    result: foreground({ exitCode: 1, stdout: 'tests/test_sample.py::test_actual FAILED\n1 failed in 0.03s\n' }) })
  assert.equal(fail.status, 'fail')
  assert.equal(fail.evidence.failed, 1)
  assert.equal(developmentCheckMatchesVerification('python3 -m pytest tests/test_sample.py',
    '/opt/venv/bin/python3 -m pytest tests/test_sample.py'), true)
  assert.equal(developmentCheckMatchesVerification(command, command), true)
  assert.equal(developmentCheckMatchesVerification('pytest -q tests/test_other.py', command), false)

  for (const unsupported of ['pytest', 'pytest .', 'pytest tests/*.py',
    'pytest --collect-only tests/test_sample.py', 'pytest tests/test_sample.py -k sample',
    'bash -lc pytest tests/test_sample.py', 'python -m pytest tests/test_sample.py && echo done',
    'python3 -m pytest /etc/passwd']) {
    assert.equal(developmentCheckIdForCommand(unsupported), null, unsupported)
  }
  for (const [stdout, exitCode] of [
    ['no tests ran in 0.01s\n', 5],
    ['s\n1 skipped in 0.03s\n', 0],
    ['x\n1 xfailed in 0.03s\n', 0],
    ['X\n1 xpassed in 0.03s\n', 0],
    ['.\n1 passed, 1 deselected in 0.03s\n', 0],
    ['E\n1 error in 0.03s\n', 1],
    ['F\n1 failed in 0.03s\n', 2],
    ['.\n1 passed in 0.03s\n1 passed in 0.03s\n', 0],
    ['echo 1 passed in 0.03s\n', 0],
  ]) {
    assert.equal(runDevelopmentChecker({ command, result: foreground({ exitCode, stdout }) }).status,
      'unknown', stdout)
  }
  assert.equal(runDevelopmentChecker({ command, result: foreground({ exitCode: 0,
    stdout: pytestPass, stdoutTruncated: true }) }).status, 'unknown')
  assert.equal(runDevelopmentChecker({ command, result: foreground({ exitCode: 0,
    stdout: pytestPass, stderr: 'pytest warning on stderr' }) }).status, 'unknown')
  assert.equal(runDevelopmentChecker({ command: 'pytest -q tests/test_sample.py',
    result: foreground({ exitCode: 0, stdout: '.\n1 passed, 1 skipped in 0.03s\n' }) }).status, 'unknown')
  assert.equal(runDevelopmentChecker({ command: 'pytest -q tests/test_sample.py',
    result: foreground({ exitCode: 0, stdout: 'F\n1 failed in 0.03s\n' }) }).status, 'unknown')
})

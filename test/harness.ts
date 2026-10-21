type Fn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: Fn }> = [];

export function test(name: string, fn: Fn): void {
  tests.push({ name, fn });
}

export async function run(suite: string): Promise<void> {
  let pass = 0;
  let fail = 0;
  for (const t of tests) {
    try {
      await t.fn();
      pass++;
    } catch (err) {
      fail++;
      console.error(`  FAIL ${suite} › ${t.name}\n    ${(err as Error).stack ?? err}`);
    }
  }
  console.log(`${fail ? '✗' : '✓'} ${suite}: ${pass} passed${fail ? `, ${fail} failed` : ''}`);
  if (fail) process.exitCode = 1;
  setTimeout(() => {
    console.error(`  ${suite}: something was still running 3 s after the last test; exiting`);
    process.exit(process.exitCode ?? 0);
  }, 3000).unref();
}

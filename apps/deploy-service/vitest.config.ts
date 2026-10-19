import { defineConfig } from 'vitest/config';

/*
  接了真实 Postgres（设了 ISPACE_TEST_PG）时，测试文件一个一个跑。

  几个 *-integration 测试指向同一个一次性库，开头都 DROP SCHEMA ispace
  再跑迁移重建。默认的文件级并行会让它们同时建 schema，互相删掉对方刚建
  的表——报出来是 `duplicate key ... pg_namespace_nspname_index` 或者表不
  存在，看着像代码坏了，其实是两份测试在抢同一个库。

  没接库时这些文件整体跳过，只剩纯单元测试，照旧并行。
*/
export default defineConfig({
  test: {
    fileParallelism: !process.env.ISPACE_TEST_PG,
  },
});

/**
 * 声明桩：真实实现在 lib/index.js（零构建链，Node ESM 直接运行）。
 * 本文件满足 bundle 规范 shape；如需 TS 源码版，请同步维护 lib 与 src。
 * 新增插件请勿直接复制本注释（它只存在于本仓库）。
 */
export const name = '@dsh-external/dsh-session-migrate';
export const inject = ['webServer', 'workspaceRegistry', 'sessionPersistence', 'sessions'];

/** 运行时入口在 lib/index.js（apply 实现）。node:zlib/fs 原生依赖，无 npm 依赖。 */
export function apply(ctx: Record<string, unknown>): void {
  void ctx;
  // 实际实现：lib/index.js；此处无逻辑，避免双维护。
}

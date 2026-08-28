
// 独立 node 进程：mock cordis ctx，调用插件 apply，检查注册行为
const mod = await import('file:///C:/Users/34021/.dsh/dsh-session-migrate/lib/index.js');
console.log('module loaded. name =', mod.name, 'inject =', JSON.stringify(mod.inject));
const registered = [];
const ctx = {
  webServer: {
    register(route) {
      registered.push(route);
      console.log('  REGISTERED:', route.kind, route.path);
      return () => { console.log('  disposed'); };
    },
  },
  workspaceRegistry: {
    list() { console.log('  workspaceRegistry.list called'); return []; },
  },
  sessionPersistence: { root: 'C:/Users/34021/.dsh/sessions' },
  sessions: { get() { console.log('  sessions.get called'); return undefined; } },
  effect: (fn, label) => { console.log('  effect setupFn run:', label); const d = fn(); console.log('  got dispose:', typeof d); },
};
try {
  mod.apply(ctx);
  console.log('APPLY OK; registered routes:', JSON.stringify(registered.map(r => r.kind + ':' + r.path)));
} catch (e) {
  console.log('APPLY THREW:', e.message);
  console.log(e.stack?.split(String.fromCharCode(10)).slice(0, 6).join(String.fromCharCode(10)));
}
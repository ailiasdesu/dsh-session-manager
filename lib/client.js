window.__ModuleLoader__.load({
	id: "@dsh-external/dsh-session-migrate",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var react = require("react");
		var react_dom = { }; // react-dom/client 仅在组件挂载时使用（createRoot 由内部 DOM 构建使用，这里不需要 createRoot）
		var h = react.createElement;
		var useEffect = react.useEffect;
		var useRef = react.useRef;

		// ---------------------------------------------------------------------------
		// 常量
		// ---------------------------------------------------------------------------
		var ROUTE = "/session-migrate/api";
		var RPC_ROUTE = "/api/session.list";
		var STYLE_ID = "sm-settings-style";

		// ---------------------------------------------------------------------------
		// 纯工具
		// ---------------------------------------------------------------------------
		function shortId(id) {
			return id.length > 8 ? id.slice(0, 8) + "…" : id;
		}
		function projectName(cwd) {
			if (!cwd) return "未知工作区";
			var segs = String(cwd).split(/[\\/]/).filter(Boolean);
			return segs[segs.length - 1] || cwd;
		}
		var rpcSeq = 0;
		function newRpcId() {
			rpcSeq += 1;
			return "sm-" + Date.now() + "-" + rpcSeq + "-" + Math.random().toString(36).slice(2, 8);
		}
		function el(tag, className, text) {
			var node = document.createElement(tag);
			if (className) node.className = className;
			if (text !== undefined) node.textContent = text;
			return node;
		}
		function emptyMsg(text) {
			return el("div", "sm-empty", text);
		}

		/** host REST：list / migrate（鉴权用当前会话 id）。 */
		async function postApi(body) {
			var res = await fetch(ROUTE, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			return await res.json();
		}
		/** 官方 RPC：列出全部会话（跨工作区）。失败返回 null。 */
		async function fetchSessionsRpc() {
			try {
				var res = await fetch(RPC_ROUTE, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ type: "client-request", rpcId: newRpcId(), method: "session.list", payload: {} }),
				});
				var body = await res.json();
				if (body?.result?.ok !== true) return null;
				return body.result.value.items ?? [];
			} catch {
				return null;
			}
		}

		// ---------------------------------------------------------------------------
		// 样式（设置内容区适配）
		// ---------------------------------------------------------------------------
		function adoptStyle() {
			if (document.getElementById(STYLE_ID)) return;
			var style = document.createElement("style");
			style.id = STYLE_ID;
			style.textContent = `
.sm-settings-root{display:flex;flex-direction:column;gap:12px;padding:6px 2px;font-size:13px;color:var(--dsw-alias-content-primary,#eee)}
.sm-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.sm-title{font-weight:600}
.sm-sub{color:var(--dsw-alias-content-secondary,#9b9b9b);font-size:12px}
.sm-refresh{margin-left:auto;border:1px solid var(--dsw-alias-stroke-default,#3a3a3a);background:transparent;color:inherit;border-radius:8px;padding:6px 14px;cursor:pointer;font-size:12px}
.sm-refresh:hover{background:var(--dsw-alias-surface-hover,#ffffff12)}
.sm-refresh:disabled{opacity:.5;cursor:default}
.sm-toast{display:none;padding:8px 12px;border-radius:8px;font-size:12px}
.sm-toast[data-show="true"]{display:block}
.sm-toast[data-kind="ok"]{background:var(--dsw-alias-state-success-tertiary,#1d3a2a);color:var(--dsw-alias-state-success-primary,#7ee2a8)}
.sm-toast[data-kind="err"]{background:var(--dsw-alias-state-error-tertiary,#3d1d1d);color:var(--dsw-alias-state-error-primary,#ff9b9b)}
.sm-cols{display:flex;gap:14px;min-height:320px;align-items:stretch}
.sm-col{flex:1;min-width:0;display:flex;flex-direction:column;border:1px solid var(--dsw-alias-stroke-default,#3a3a3a);border-radius:12px;overflow:hidden}
.sm-col-head{padding:8px 12px;font-weight:600;background:var(--dsw-alias-surface-sunken,#161617);border-bottom:1px solid var(--dsw-alias-stroke-default,#3a3a3a)}
.sm-col-body{flex:1;overflow-y:auto;max-height:420px;padding:6px}
.sm-row{padding:7px 10px;border-radius:8px;cursor:grab;display:flex;flex-direction:column;gap:2px}
.sm-row:hover{background:#ffffff0b}
.sm-row[dragging="true"]{opacity:.45}
.sm-row-main{display:flex;align-items:center;gap:6px;min-width:0;width:100%}
.sm-row-title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sm-current-dot{color:var(--dsw-alias-state-info-primary,#4c8dff);font-weight:600;flex:none}
.sm-row-sub{color:var(--dsw-alias-content-secondary,#9b9b9b);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sm-ws-row{padding:9px 10px;border-radius:8px;display:flex;flex-direction:column;gap:2px;border:1px solid transparent}
.sm-ws-row:hover{background:#ffffff0b}
.sm-ws-row[over="true"]{border-color:var(--dsw-alias-state-info-primary,#4c8dff);background:#4c8dff14}
.sm-ws-title{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sm-ws-path{color:var(--dsw-alias-content-secondary,#9b9b9b);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sm-confirm-bar{display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:8px;font-size:12px;background:var(--dsw-alias-state-warn-tertiary,#3d3220);color:var(--dsw-alias-state-warn-primary,#ffd679);border:1px solid var(--dsw-alias-state-warn-primary,#ffd67955)}
.sm-confirm-text{flex:1}
.sm-confirm-ok{border:0;background:var(--dsw-alias-state-success-primary,#2c8f5c);color:#fff;border-radius:6px;padding:5px 12px;cursor:pointer;font-size:12px}
.sm-confirm-cancel{border:1px solid var(--dsw-alias-stroke-default,#3a3a3a);background:transparent;color:inherit;border-radius:6px;padding:5px 12px;cursor:pointer;font-size:12px}
.sm-diag{padding:8px 12px;border-radius:8px;font-size:12px;background:var(--dsw-alias-state-error-tertiary,#3d1d1d);color:var(--dsw-alias-state-error-primary,#ff9b9b)}
.sm-move-btn{margin-left:auto;flex:none;border:1px solid var(--dsw-alias-stroke-default,#3a3a3a);background:#ffffff0d;color:inherit;border-radius:6px;padding:2px 8px;font-size:11px;cursor:pointer;opacity:0;transition:opacity .12s}
.sm-row:hover .sm-move-btn{opacity:1}
.sm-move-btn:hover{background:#ffffff1a}
.sm-empty{color:var(--dsw-alias-content-secondary,#9b9b9b);padding:14px;text-align:center;font-size:12px}
`;
			document.head.appendChild(style);
		}

		// ---------------------------------------------------------------------------
		// 内容区 UI（纯 DOM 构建；无浮层/悬浮按钮）
		// ---------------------------------------------------------------------------
		function currentSessionId(ctx) {
			try {
				return ctx.sessions.list.getSnapshot().current;
			} catch {
				return undefined;
			}
		}

		function diag(st, text) {
			if (!st || st.disposed) return;
			st.diag.textContent = text || "";
			st.diag.hidden = !text;
		}

		function renderConfirmBar(st) {
			if (!st || st.disposed) return;
			var p = st.pendingMigrate;
			if (!p) { st.confirmBar.hidden = true; return; }
			st.confirmBar.hidden = false;
			st.confirmBar.textContent = "";
			st.confirmBar.appendChild(el("span", "sm-confirm-text", "将会话「" + shortId(p.targetId) + "」迁移到「" + p.targetLabel + "」？"));
			var okBtn = el("button", "sm-confirm-ok", "确认迁移");
			okBtn.type = "button";
			okBtn.addEventListener("click", async () => {
				var req = { sessionId: st.sessionId, action: "migrate", targetId: p.targetId, targetPath: p.targetPath };
				st.pendingMigrate = null;
				renderConfirmBar(st);
				toast(st, "正在迁移…", "ok");
				var resp;
				try {
					resp = await postApi(req);
				} catch (e) {
					toast(st, "请求失败：" + String(e?.message ?? e), "err");
					return;
				}
				if (resp?.ok === true) {
					toast(st, "✅ " + (resp.message ?? "迁移成功"), "ok");
				} else {
					toast(st, "❌ " + (resp?.message ?? "迁移失败") + (resp?.code ? "（" + resp.code + "）" : ""), "err");
				}
				void refreshAll(st);
			});
			var cancelBtn = el("button", "sm-confirm-cancel", "取消");
			cancelBtn.type = "button";
			cancelBtn.addEventListener("click", () => {
				st.pendingMigrate = null;
				renderConfirmBar(st);
			});
			st.confirmBar.append(okBtn, cancelBtn);
		}

		function toast(st, text, kind) {
			if (!st || st.disposed) return;
			st.toast.textContent = text;
			st.toast.dataset.kind = kind;
			st.toast.dataset.show = "true";
			if (st.toastTimer !== null) window.clearTimeout(st.toastTimer);
			st.toastTimer = window.setTimeout(() => {
				st.toast.dataset.show = "false";
				st.toastTimer = null;
			}, 4000);
		}

		async function refreshAll(st) {
			if (!st || st.disposed) return;
			st.sessionId = currentSessionId(ctxRef);
			st.refreshBtn.disabled = true;
			st.refreshBtn.textContent = "刷新中…";
			diag(st, "");
			var sessionsList = null;
			try {
				sessionsList = await fetchSessionsRpc();
				if (sessionsList === null) diag(st, "会话列表 RPC 失败（sessionId=" + st.sessionId + "）");
			} catch (e) {
				diag(st, "会话列表异常：" + String(e?.message ?? e) + "（sessionId=" + st.sessionId + "）");
			}
			var workspaces = [];
			try {
				var hostResp = await postApi({ sessionId: st.sessionId, action: "list" });
				if (hostResp?.ok === true) workspaces = hostResp.workspaces ?? [];
				else diag(st, "工作区接口失败：" + (hostResp?.message ?? JSON.stringify(hostResp)));
			} catch (e) {
				diag(st, "工作区接口异常：" + String(e?.message ?? e));
			}
			if (st.disposed) return;
			renderSessions(st, sessionsList);
			renderWorkspaces(st, workspaces);
			st.refreshBtn.disabled = false;
			st.refreshBtn.textContent = "刷新";
		}

		function renderSessions(st, items) {
			st.sessionsColBody.textContent = "";
			if (items === null) {
				st.sessionsColBody.appendChild(emptyMsg("会话列表不可用，点击刷新重试"));
				return;
			}
			if (items.length === 0) {
				st.sessionsColBody.appendChild(emptyMsg("无会话"));
				return;
			}
			for (const item of items) {
				var title = item.projections?.values?.title ?? shortId(item.sessionId);
				var cwd = item.cwd ?? "";
				var isCurrent = item.sessionId === st.sessionId;
				var row = el("div", "sm-row");
				var main = el("div", "sm-row-main");
				main.appendChild(el("span", "sm-row-title", title));
				if (isCurrent) main.appendChild(el("span", "sm-current-dot", "●当前"));
				var sub = el("div", "sm-row-sub", projectName(cwd));
				row.append(main, sub);
				if (isCurrent) {
					row.addEventListener("dragstart", (ev) => {
						ev.preventDefault();
						toast(st, "当前活动会话不能迁移", "err");
					});
				} else {
					row.draggable = true;
					row.addEventListener("dragstart", (ev) => {
						ev.dataTransfer.setData("text/plain", item.sessionId);
						ev.dataTransfer.effectAllowed = "move";
						row.setAttribute("dragging", "true");
					});
					row.addEventListener("dragend", () => row.removeAttribute("dragging"));
					// 点击式迁移入口（不依赖拖放）：点击选择目标工作区
					var moveBtn = el("button", "sm-move-btn", "迁移");
					moveBtn.type = "button";
					moveBtn.title = "点击式迁移：选择目标工作区";
					moveBtn.addEventListener("click", () => {
						st.clickTarget = { targetId: item.sessionId, title: title };
						renderWorkspaces(st, st.currentWorkspaces || []);
						toast(st, "请在右侧选择一个目标工作区，然后点击确认", "ok");
					});
					row.appendChild(moveBtn);
				}
				st.sessionsColBody.appendChild(row);
			}
		}

		function renderWorkspaces(st, workspaces) {
			st.currentWorkspaces = workspaces;
			st.wsColBody.textContent = "";
			if (workspaces.length === 0) {
				st.wsColBody.appendChild(emptyMsg("无工作区（请先在左侧打开项目）"));
				return;
			}
			for (const ws of workspaces) {
				var row = el("div", "sm-ws-row");
				row.appendChild(el("span", "sm-ws-title", ws.title ?? ws.path));
				row.appendChild(el("div", "sm-ws-path", ws.path));
				// 点击式：选择该工作区为目标
				row.addEventListener("click", () => {
					if (!st.clickTarget) return;
					st.pendingMigrate = { targetId: st.clickTarget.targetId, targetPath: ws.path, targetLabel: ws.title ?? ws.path };
					st.clickTarget = null;
					renderConfirmBar(st);
				});
				let overDepth = 0;
				row.addEventListener("dragenter", (ev) => {
					ev.preventDefault();
					overDepth += 1;
					row.setAttribute("over", "true");
				});
				row.addEventListener("dragover", (ev) => {
					ev.preventDefault();
				});
				row.addEventListener("dragleave", () => {
					overDepth -= 1;
					if (overDepth <= 0) { overDepth = 0; row.removeAttribute("over"); }
				});
				row.addEventListener("drop", (ev) => {
					ev.preventDefault();
					overDepth = 0;
					row.removeAttribute("over");
					var targetId = ev.dataTransfer.getData("text/plain");
					if (!targetId) return;
					if (targetId === st.sessionId) {
						toast(st, "当前活动会话不能迁移", "err");
						return;
					}
					// 两段式确认：drop 后显示页面内确认条（原生 confirm 在 Chromium 拖放手势中会被静默拦截）
					st.pendingMigrate = { targetId, targetPath: ws.path, targetLabel: ws.title ?? ws.path };
					renderConfirmBar(st);
				});
				st.wsColBody.appendChild(row);
			}
		}

		function buildSectionUI(ctx) {
			var root = el("div", "sm-settings-root");
			var toolbar = el("div", "sm-toolbar");
			toolbar.appendChild(el("span", "sm-title", "会话迁移"));
			toolbar.appendChild(el("span", "sm-sub", "把左侧会话行拖到右侧目标工作区 → 确认后完成迁移（带备份，可回滚）"));
			var refreshBtn = el("button", "sm-refresh", "刷新");
			refreshBtn.type = "button";
			toolbar.appendChild(refreshBtn);
			var diagEl = el("div", "sm-diag", "");
			diagEl.hidden = true;
			var toastEl = el("div", "sm-toast");
			var confirmBar = el("div", "sm-confirm-bar");
			confirmBar.hidden = true;
			var cols = el("div", "sm-cols");
			var sessionsCol = el("div", "sm-col");
			sessionsCol.appendChild(el("div", "sm-col-head", "会话"));
			var sessionsBody = el("div", "sm-col-body");
			sessionsCol.appendChild(sessionsBody);
			var wsCol = el("div", "sm-col");
			wsCol.appendChild(el("div", "sm-col-head", "目标工作区"));
			var wsBody = el("div", "sm-col-body");
			wsCol.appendChild(wsBody);
			cols.append(sessionsCol, wsCol);
			root.append(toolbar, diagEl, confirmBar, toastEl, cols);

			var st = {
				root, toast: toastEl, toastTimer: null,
				sessionsColBody: sessionsBody, wsColBody: wsBody,
				refreshBtn, disposed: false, diag: diagEl, confirmBar: confirmBar,
				pendingMigrate: null, sessionId: currentSessionId(ctx),
			};
			refreshBtn.addEventListener("click", () => void refreshAll(st));
			uiState = st;
			void refreshAll(st);
			return st;
		}
		var uiState = null;

		function disposeSectionUI(st) {
			if (!st || st.disposed) return;
			st.disposed = true;
			st.clickTarget = null;
			if (st.toastTimer !== null) window.clearTimeout(st.toastTimer);
			if (uiState === st) uiState = null;
		}

		// ---------------------------------------------------------------------------
		// React 壳（挂进设置面板 section；内容是纯 DOM）
		// ---------------------------------------------------------------------------
		var ctxRef = null;
		function SessionMigrateSection() {
			var ref = useRef(null);
			useEffect(() => {
				var host = ref.current;
				if (!host || !ctxRef) return;
				var st = buildSectionUI(ctxRef);
				host.appendChild(st.root);
				return () => {
					disposeSectionUI(st);
					st.root.remove();
				};
			}, []);
			return h("div", { ref, style: { width: "100%" } });
		}

		// ---------------------------------------------------------------------------
		// 插件契约
		// ---------------------------------------------------------------------------
		var name = "@dsh-external/dsh-session-migrate";
		var inject = ["sessions", "slots"];

		function apply(ctx) {
			adoptStyle();
			ctxRef = ctx;
			ctx.effect(() => () => {
				var style = document.getElementById(STYLE_ID);
				if (style) style.remove();
			}, "session-migrate: style");
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "session-migrate",
				order: 65,
				label: () => "会话迁移",
			}, SessionMigrateSection));
		}

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
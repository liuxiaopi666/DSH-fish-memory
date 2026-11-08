// dsh-fish-memory · 浏览器半（DSH 客户端插件）
//
// 写法对齐本机两个确实出现在左侧栏的插件：
//   dsh-context（上下文洞察）与 dsh-bili-pond（B站鱼塘）。
// 教训（上一版为什么整块没反应）：
//   ① 直接读 ctx.slots 在 cordis 里会抛 "cannot get property slots without inject"；
//      而那句写在 try 之外 → apply 直接崩，两处槽位都没注册上，界面上毫无痕迹。
//      现在**全部**包在一个 try 里，取服务先用 ctx.get('slots')（bili-pond 的取法）。
//   ② 每一步都往宿主打 /fish-memory/api/ping 探针，日志能看出断在哪一步。
window.__ModuleLoader__.load({
  id: "dsh-fish-memory",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require("react");
    var h = React.createElement;

    var PANEL_ID = "fish-memory";
    var BASE = "/fish-memory";

    function ping(stage, extra) {
      try {
        var q = "?stage=" + encodeURIComponent(stage) + (extra ? "&extra=" + encodeURIComponent(String(extra)) : "");
        var p = fetch(BASE + "/api/ping" + q, { credentials: "same-origin", keepalive: true });
        if (p && typeof p.catch === "function") p.catch(function () {});
      } catch (error) {}
    }

    function glyphStyle(size, active) {
      return {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: (size || 16) + "px",
        height: (size || 16) + "px",
        fontSize: (size || 16) + "px",
        lineHeight: 1,
        opacity: active ? 1 : 0.72,
      };
    }

    function MemoryGlyph(props) {
      var size = props && typeof props.size === "number" ? props.size : 16;
      var active = Boolean(props && props.active);
      return h("span", { style: glyphStyle(size, active), "aria-hidden": "true" }, "\u{1F9E0}");
    }

    function MemoryPanel() {
      return h("iframe", {
        src: BASE + "/?embed=1",
        title: "记忆系统控制台",
        style: {
          width: "100%",
          height: "100%",
          minHeight: "70vh",
          border: "0",
          display: "block",
          background: "transparent",
        },
      });
    }

    /** 取 slots 服务：先 ctx.get('slots')（B站鱼塘的取法），再退回 ctx.slots；两种都抛也不许外泄 */
    function resolveSlots(ctx) {
      var fromGet = null;
      try {
        if (ctx && typeof ctx.get === "function") fromGet = ctx.get("slots") || null;
      } catch (error) {
        ping("slots-get-error", error && error.message);
      }
      if (fromGet) return fromGet;
      try {
        return (ctx && ctx.slots) || null;
      } catch (error) {
        ping("slots-prop-error", error && error.message);
      }
      return null;
    }

    function apply(ctx) {
      try {
        ping("apply");
        var slots = resolveSlots(ctx);
        if (!slots) {
          ping("slots-missing");
          console.warn("[fish-memory] slots service unavailable; client half deferred");
          return function () {};
        }
        ping("slots-ok");

        var register = function (options, component, stage) {
          try {
            var dispose = slots.register(options, component);
            ping(stage);
            return dispose;
          } catch (error) {
            ping(stage + "-error", error && error.message);
            return function () {};
          }
        };

        var registerRow = function () {
          return register({ name: "sidebar.panellist", id: PANEL_ID, order: 5, label: "记忆" }, MemoryGlyph, "panellist-ok");
        };
        var registerMain = function () {
          return register({ name: "main", key: PANEL_ID }, MemoryPanel, "main-ok");
        };

        if (typeof slots.inject === "function") {
          slots.inject("sidebar.panellist", registerRow);
          slots.inject("main", registerMain);
          ping("injected");
        } else {
          registerRow();
          registerMain();
          ping("direct-register-ok");
        }
        return function () {};
      } catch (error) {
        ping("apply-error", error && error.message);
        console.warn("[fish-memory] client apply failed:", error);
        return function () {};
      }
    }

    exports.apply = apply;
    exports.inject = [];
    exports.MemoryGlyph = MemoryGlyph;
    exports.MemoryPanel = MemoryPanel;
    exports.PANEL_ID = PANEL_ID;
    return module.exports;
  },
});

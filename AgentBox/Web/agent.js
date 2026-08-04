/**
 * AgentBox Web 层核心脚本
 * Pi 风格自主 Agent + 对话 UI，通过 WKScriptMessageHandler 桥接原生 llama.cpp 推理。
 * 全局命名空间 WebLobeXxx 保持与 WebLobe 兼容。
 */
window.AgentCore = { tools: {}, skills: [], genSessions: {}, streaming: {} };
// 原生状态显示（顶层初始化，确保一致）
window.AgentUI = { onNativeStatus: function (st, name) {
  var pill = document.querySelector('.model-pill');
  var nameEl = document.getElementById('modelName');
  if (!nameEl) return;
  if (st === 'loaded' && name) { pill.classList.add('loaded'); nameEl.textContent = name; }
  else if (st === 'no-model') { nameEl.textContent = '未加载模型'; pill.classList.remove('loaded'); }
} };
// 兼容 WebLobe 命名，工具/技能系统
window.WebLobeTools = { schemas: [], names: [], impls: {} };
window.WebLobeSkills = { loadAll: function(){ return AgentCore.skills; } };

(function () {
  'use strict';

  /* ================= 工具注册 ================= */
  var T = AgentCore.tools;
  function register(name, desc, params, impl) {
    T[name] = { desc: desc, params: params, impl: impl };
    WebLobeTools.names.push(name);
    WebLobeTools.schemas.push({ name: name, description: desc, parameters: params });
    WebLobeTools.impls[name] = impl;
  }

  // 计算器
  register('calculator', '精确数学计算，支持四则运算/括号/幂。', { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] },
    function (args) {
      var expr = String(args.expression || '').replace(/[^0-9+\-*/().%^,\s]/g, '');
      if (!expr) return '错误：无表达式';
      try { var f = new Function('"use strict";return(' + expr + ');'); var r = f(); return isFinite(r) ? String(Math.round(r * 1e8) / 1e8) : '错误'; }
      catch (e) { return '计算错误：' + e.message; }
    });

  // 笔记
  register('note', '写入/读取一条笔记，保存任务中间产物。', { type: 'object', properties: { action: { type: 'string', enum: ['write', 'read'] }, name: { type: 'string' }, content: { type: 'string' } }, required: ['action', 'name'] },
    function (args) {
      var notes = JSON.parse(localStorage.getItem('agentbox_notes') || '{}');
      if (args.action === 'write') { notes[args.name] = args.content || ''; localStorage.setItem('agentbox_notes', JSON.stringify(notes)); return '已保存笔记 "' + args.name + '"'; }
      var v = notes[args.name]; return v !== undefined ? v : '未找到笔记 "' + args.name + '"';
    });

  // 记忆
  register('memory', '读写长期记忆，跨会话记住偏好。', { type: 'object', properties: { action: { type: 'string', enum: ['save', 'recall'] }, content: { type: 'string' } }, required: ['action'] },
    function (args) {
      var mem = JSON.parse(localStorage.getItem('agentbox_memory') || '{"items":[]}');
      if (args.action === 'save') { mem.items.push({ t: Date.now(), c: args.content || '' }); if (mem.items.length > 50) mem.items = mem.items.slice(-50); localStorage.setItem('agentbox_memory', JSON.stringify(mem)); return '已保存到长期记忆'; }
      var items = mem.items || [];
      return items.length ? '长期记忆：\n' + items.slice(-10).map(function (i) { return '- ' + i.c; }).join('\n') : '暂无记忆';
    });

  // 任务规划
  register('planner', '把复杂任务拆解为有序子步骤。', { type: 'object', properties: { task: { type: 'string' }, steps: { type: 'array', items: { type: 'string' } } }, required: ['task'] },
    function (args) {
      var s = (args.steps || []).map(function (x, i) { return (i + 1) + '. ' + x; }).join('\n');
      return '任务计划：\n' + (s || '未提供步骤');
    });

  // JSON 处理
  register('json_tool', 'JSON 解析/提取/格式化。', { type: 'object', properties: { action: { type: 'string', enum: ['parse', 'extract', 'format'] }, data: { type: 'string' }, path: { type: 'string' } }, required: ['action', 'data'] },
    function (args) {
      try {
        var d = JSON.parse(args.data);
        if (args.action === 'format') return JSON.stringify(d, null, 2);
        if (args.action === 'extract') {
          var keys = String(args.path || '').split('.'), cur = d;
          for (var i = 0; i < keys.length; i++) { var m = keys[i].match(/^(\w+)\[(\d+)\]$/); cur = m ? (cur[m[1]] || [])[+m[2]] : cur[keys[i]]; if (cur === undefined) return '路径不存在'; }
          return typeof cur === 'object' ? JSON.stringify(cur) : String(cur);
        }
        return '解析成功，' + JSON.stringify(d).length + ' 字符';
      } catch (e) { return 'JSON 错误：' + e.message; }
    });

  // 时间
  register('get_time', '获取当前日期时间与时区。', { type: 'object', properties: {} },
    function () {
      var n = new Date();
      return '当前时间：' + n.toLocaleString('zh-CN', { hour12: false }) + '\n时区：UTC+' + (-n.getTimezoneOffset() / 60);
    });

  // 运行技能
  register('run_skill', '调用某个已注册技能执行特定类型工作。', { type: 'object', properties: { name: { type: 'string' }, input: { type: 'string' } }, required: ['name', 'input'] },
    function (args) {
      var sk = AgentCore.skills.filter(function (s) { return s.name === args.name; })[0];
      if (!sk) return '未找到技能 "' + args.name + '"（可用：' + AgentCore.skills.map(function (s) { return s.name; }).join(', ') + '）';
      return '[技能 ' + sk.name + ']\n' + sk.content + '\n\n[待处理]\n' + String(args.input || '');
    });

  function execTool(name, args) {
    if (!T[name]) return '错误：未知工具 "' + name + '"';
    try { var r = T[name].impl(args || {}); return typeof r === 'string' ? r : JSON.stringify(r); }
    catch (e) { return '工具执行错误：' + e.message; }
  }
  WebLobeTools.executeTool = execTool;

  // 内置技能
  AgentCore.skills = [
    { name: 'report_writer', description: '把零散信息整理成结构化报告', content: '步骤：1确认主题 2整理信息 3按【引言-主体-结论】组织 4用要点呈现' },
    { name: 'data_analysis', description: '对数据列表做统计洞察', content: '步骤：1用 code/calculator 计算均值总和 2输出洞察结论' },
    { name: 'plan_breakdown', description: '把宏大目标拆解为可执行子步骤', content: '步骤：1用 planner 生成子步骤 2标注产出 3给顺序' },
    { name: 'memory_manager', description: '主动记录重要偏好到长期记忆', content: '步骤：1用 memory save 写入 2一句话概括核心' }
  ];

  /* ================= 原生桥：LLM 生成 ================= */
  // 发起一次生成，返回 Promise<最终文本>；token 由 Swift 通过 window.AgentNativeStream 流式推入
  function generate(messages) {
    var cbId = 'g' + Date.now() + '_' + Math.floor(Math.random() * 99999);
    // 拼 prompt：把 messages 转成文本（系统/用户/助手）
    var prompt = '';
    for (var i = 0; i < messages.length; i++) {
      var m = messages[i];
      if (m.role === 'system') prompt += '[System]\n' + m.content + '\n\n';
      else if (m.role === 'user') prompt += 'Human: ' + m.content + '\n';
      else if (m.role === 'assistant') prompt += 'Assistant: ' + m.content + '\n';
      else if (m.role === 'toolResult') prompt += 'Tool(' + (m.name || '') + ') result: ' + m.content + '\n';
    }
    prompt += '\nAssistant:';

    return new Promise(function (resolve, reject) {
      var session = { cbId: cbId, buffer: '', state: 'pending', resolver: resolve, rejecter: reject };
      AgentCore.genSessions[cbId] = session;
      AgentCore.streaming[cbId] = true;
      window.AgentUI.onNativeStatus('generating');
      try {
        window.webkit.messageHandlers.llama.postMessage({ type: 'gen', text: prompt, cbId: cbId });
      } catch (e) { delete AgentCore.genSessions[cbId]; reject(new Error('桥接失败：' + e.message)); }
    });
  }

  // 由 Swift 的 evaluateJavaScript 调用
  window.AgentNativeStream = function (cbId, token) {
    var s = AgentCore.genSessions[cbId];
    if (s) { s.buffer += token; if (s.onStream) s.onStream(token); }
  };
  window.AgentNativeDone = function (cbId, finalText, meta) {
    var s = AgentCore.genSessions[cbId];
    if (!s) return;
    delete AgentCore.genSessions[cbId];
    delete AgentCore.streaming[cbId];
    window.AgentUI.onNativeStatus('idle');
    if (s.onDone) s.onDone(s.buffer || finalText, meta || {});
    s.resolver(s.buffer || finalText);
  };
  WebLobeLlmBridge = { generate: generate, execTool: execTool };

  /* ================= Agent 循环 ================= */
  function buildSystemPrompt() {
    var names = WebLobeTools.names.join(', ');
    var skillsBlock = AgentCore.skills.length ?
      '\n## 可用技能\n' + AgentCore.skills.map(function (s) { return '- ' + s.name + ': ' + s.description; }).join('\n') : '';
    return '你是运行在本机的自主智能体 AgentBox，能自主规划并执行任务直到完成。\n\n'
      + '可用工具：' + names + '\n'
      + '当需要调用工具时，在回复最开头输出一行严格 JSON：\n{"tool":"工具名","args":{...}}\n'
      + '后面可跟用户可读说明文字。一次只调用一个工具，拿到结果后决定下一步。\n'
      + '任务完成后用简洁清晰的中文总结。' + skillsBlock;
  }

  // 一次模型交互：返回 {text, toolExecuted}
  async function llmStep(agentMsgs, onText, onTool) {
    var content;
    try { content = await generate(agentMsgs); }
    catch (e) { throw e; }
    // 解析 JSON 工具调用协议
    var match = content.match(/^\s*(\{[\s\S]*?"tool"[\s\S]*?\})\s*([\s\S]*)$/);
    if (match) {
      try {
        var cmd = JSON.parse(match[1]);
        var text = match[2] || '';
        if (cmd.tool) {
          if (text.trim() && onText) onText(text.trim());
          var out = execTool(cmd.tool, cmd.args || {});
          if (onTool) onTool(cmd.tool, out, cmd.args || {});
          agentMsgs.push({ role: 'toolResult', content: out });
          return { toolExecuted: true };
        }
      } catch (e) {}
    }
    if (onText) onText(content);
    return { toolExecuted: false };
  }

  // 执行 Agent 自主任务
  async function runAgentTask(userTask, hooks, maxSteps) {
    maxSteps = maxSteps || 6;
    var msgs = [{ role: 'system', content: buildSystemPrompt() }, { role: 'user', content: userTask }];
    if (hooks && hooks.onAgentStart) hooks.onAgentStart();
    var final = '';
    for (var step = 0; step < maxSteps; step++) {
      if (hooks && hooks.onStep) hooks.onStep(step + 1);
      var res;
      try { res = await llmStep(msgs, hooks ? hooks.onText : null, hooks ? hooks.onTool : null); }
      catch (e) {
        if (hooks && hooks.onError) hooks.onError(e.message);
        return final;
      }
      if (res.text) final = res.text;
      if (!res.toolExecuted) break;
    }
    if (hooks && hooks.onAgentEnd) hooks.onAgentEnd(final);
    return final;
  }

  // AgentCore 导出
  AgentCore.runTask = runAgentTask;
  AgentCore.buildSystemPrompt = buildSystemPrompt;

  /* ================= UI 控制器 ================= */
  function initUI() {
    var msgsEl = document.getElementById('msgs');
    var input = document.getElementById('input');
    var sendBtn = document.getElementById('send');
    var emptyEl = document.getElementById('empty');
    var mode = 'normal';
    var busy = false;
    var history = [];

    function addMsg(text, cls, role) {
      if (emptyEl) emptyEl.style.display = 'none';
      var m = document.createElement('div');
      m.className = 'msg ' + (cls || (role === 'user' ? 'user' : 'agent'));
      m.textContent = text;
      var tag = document.createElement('span');
      tag.className = 'role-tag';
      tag.textContent = role === 'user' ? '你' : (cls === 'tool' ? '工具' : 'Agent');
      if (cls === 'tool') { m.innerHTML = ''; m.appendChild(tag); m.appendChild(document.createTextNode(text)); }
      else { m.appendChild(tag); m.appendChild(document.createElement('br')); m.appendChild(document.createTextNode(text)); }
      msgsEl.appendChild(m);
      msgsEl.scrollTop = msgsEl.scrollHeight;
      return m;
    }

    function addThinking() {
      if (emptyEl) emptyEl.style.display = 'none';
      var m = document.createElement('div');
      m.className = 'thinking';
      m.innerHTML = '<span class="spinner"></span><span>Agent 正在思考并执行…</span>';
      msgsEl.appendChild(m);
      msgsEl.scrollTop = msgsEl.scrollHeight;
      return m;
    }

    async function send(text) {
      if (busy) return;
      if (!text.trim()) return;
      // 清空聊天区，追加用户消息
      if (msgsEl.firstChild && msgsEl.firstChild.id === 'empty') msgsEl.firstChild.remove();
      addMsg(text.trim(), 'user', 'user');
      if (history.length > 20) history = history.slice(-20);
      history.push({ role: 'user', content: text.trim() });
      input.value = '';
      autoGrow();
      busy = true; sendBtn.disabled = true;

      if (mode === 'normal') {
        // 对话模式：基于当前历史（已含最新 user 消息）做一轮生成
        var generated = await generate(history.slice(-8));
        addMsg(generated, 'agent', 'agent');
        history.push({ role: 'assistant', content: generated });
      } else {
        // Agent 模式
        var think = addThinking();
        await runAgentTask(text.trim(), {
          onExt: null,
          onText: function (t) { },
          onTool: function (name, out, args) {
            addMsg('▶ 调用工具 ' + name + (args ? ' ' + JSON.stringify(args).slice(0, 120) : ''), 'tool', null);
            addMsg('  ↳ ' + String(out).slice(0, 600), 'tool', null);
          },
          onError: function (err) { addMsg('错误：' + err, 'err', null); },
          onAgentStart: function () { },
          onStep: function (n) { },
          onAgentEnd: function (final) { think.remove(); addMsg(final || '(无输出)', 'agent', 'agent'); history.push({ role: 'assistant', content: final || '' }); }
        }, 6).then(function () {
          if (document.querySelector('.thinking')) document.querySelectorAll('.thinking').forEach(function (el) { el.remove(); });
        });
      }
      busy = false; sendBtn.disabled = false;
      if (msgsEl.isEmpty) {}
    }

    // 模式切换
    document.getElementById('modeNormal').addEventListener('click', function () {
      mode = 'normal';
      document.getElementById('modeNormal').classList.add('active');
      document.getElementById('modeAgent').classList.remove('active');
    });
    document.getElementById('modeAgent').addEventListener('click', function () {
      mode = 'agent';
      document.getElementById('modeAgent').classList.add('active');
      document.getElementById('modeNormal').classList.remove('active');
    });

    // 快捷 chip
    document.querySelectorAll('.quick-chip').forEach(function (chip) {
      chip.addEventListener('click', function () { send(chip.getAttribute('data-p')); });
    });

    sendBtn.addEventListener('click', function () { send(input.value); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input.value); }
    });
    function autoGrow() {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    }
    input.addEventListener('input', autoGrow);

    // 刷新按钮清空对话
    document.getElementById('refreshBtn').addEventListener('click', function (e) {
      history = [];
      msgsEl.innerHTML = '';
      msgsEl.appendChild(emptyEl);
      emptyEl.style.display = 'flex';
    });

    // 供外部访问的 UI 辅助
    window.AgentUI.isEmpty = function () { return history.length === 0; };
    window.AgentUI.resetConversation = function () {
      history = [];
      msgsEl.innerHTML = '';
      msgsEl.appendChild(emptyEl);
      emptyEl.style.display = 'flex';
    };
    sendBtn.disabled = false;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initUI);
  } else {
    initUI();
  }
})();

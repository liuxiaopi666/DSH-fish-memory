// 收录策略验收：重要性 / 长期价值 / 标题 / 标签
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importanceScore, isDurable, durabilityScore, buildTitle, deriveTags, IMPORTANT_THRESHOLD } from '../lib/ingest.js';

const 该留 = [
  '以后会话的消息发送全部使用中文，英文我看不懂',
  '下次收到B站的私信后开一个新会话，不要占用使用过的会话',
  '不是所有会话消息都要收录，只收录一些重要的记忆，一些无关的记忆就不要乱收录了',
  '百度千帆大模型，openAI协议兼容是 https://qianfan.baidubce.com/v2 ，key 是 bce-v3/xxx',
  '插件目录 ~/.dsh/plugins/dsh-fish-memory；数据在 ~/.dsh/fish-memory',
  '我想学习C语言程序设计，来应对专升本考试',
  '你的总结错了，这个是你的妈妈“大Deepseek”告诉我的，你是“小Deepseek”',
];
const 该丢 = [
  '你帮我做一个磁力下载程序，让我能下载网友给我的磁力链接',
  '请你在终端上直接更新dsh的版本到最新版',
  '把 dsh-meme 这个插件列入白名单',
  '只回复 OK 两个字，不要调用任何工具，不要写文件',
  'http://127.0.0.1:8788/api/state',
  '502: {"message":"Upstream service temporarily unavailable"}',
  '请调用 mcp__snowluma__qq_send_message 发一条',
  '继续',
  '好的，谢谢',
];

test('长期有用的留下：偏好 / 设定 / 配置 / 位置 / 目标（做完就忘的一次性任务不留）', () => {
  for (const text of 该留) {
    assert.equal(isDurable(text), true, '该留却被丢：' + text.slice(0, 30));
    assert.ok(durabilityScore(text).score >= 2, text.slice(0, 20) + ' 分数应达标');
  }
  for (const text of 该丢) {
    assert.equal(importanceScore(text) >= IMPORTANT_THRESHOLD && isDurable(text), false, '该丢却留：' + text.slice(0, 30));
  }
});

test('重要性打分：寒暄/确认/纯链接/报错粘贴一律 0', () => {
  for (const text of ['继续', '好的', '嗯嗯', '辛苦了', 'http://a.b/c', '502: {"message":"x"}', '']) {
    assert.equal(importanceScore(text), 0, '不该给分：' + JSON.stringify(text));
  }
  assert.ok(importanceScore('以后刷B站看到同类时，试着发消息互动，但不要灌水，格式也要简洁') >= IMPORTANT_THRESHOLD);
});

test('标题一眼能看出类别与要点', () => {
  assert.equal(buildTitle('以后会话的消息发送全部使用中文，英文我看不懂').startsWith('偏好：'), true);
  assert.equal(buildTitle('B站私信唤醒开新会话这个功能怎么不生效了').startsWith('问题：'), true);
  assert.equal(buildTitle('我想学习C语言程序设计，来应对专升本考试').startsWith('需求：'), true);
  const long = buildTitle('@C:\\Users\\x\\Desktop\\记忆系统方案.md 根据这个写一个记忆系统插件，实现里面的内容，并做一个可视化界面');
  assert.ok(long.length <= 30, '标题要短：' + long);
  assert.ok(!long.includes('C:\\Users'), '标题不该带路径');
});

test('标签只给主题词：不出现日期、路径、工作区名', () => {
  const tags = deriveTags('以后每次刷B站私信都要开新会话，标签只要主题词，别把 2026-10-30 或 C:\\x\\y 当标签');
  assert.ok(tags.length > 0 && tags.length <= 3);
  for (const tag of tags) {
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(tag), '不该有日期标签: ' + tag);
    assert.ok(!/[\\/]/.test(tag), '不该有路径标签: ' + tag);
    assert.ok(tag.length <= 6, '标签要简洁: ' + tag);
  }
});

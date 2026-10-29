/*
 * 无畏征召 / 全局 BP — 纯逻辑核心
 * 规则依据：Riot 官方赛事自 2025 赛季启用的 Full Fearless Draft
 * - 职业征召顺序：3 ban / 3 pick / 2 ban / 2 pick
 * - 已选用英雄在系列赛后续小局中双方均不可再选
 * - 仅禁用、未被选用的英雄不会进入全局池
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.DraftCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STATE_VERSION = 2;
  const SIDES = ['blue', 'red'];
  const SIDE_LABEL = { blue: '蓝方', red: '红方' };
  const SIDE_SHORT = { blue: '蓝', red: '红' };
  const ORDER_LABEL = { first: 'BP 先选', second: 'BP 后选' };
  const ORDER_SHORT = { first: '先选', second: '后选' };
  const TYPE_LABEL = { ban: '禁用', pick: '选用' };
  const MODE_LABEL = { hard: '硬性全局', soft: '软性全局' };
  const PHASE_LABEL = { drafting: 'BP 进行中', review: 'BP 已完成', between: '局间准备', finished: '系列赛结束' };

  // 官方职业征召（Tournament Draft）20 手顺序。
  // first / second 表示 BP 顺序，而不是地图阵营。
  // 2026 First Selection 起，地图蓝/红与 BP 先/后选可以独立组合。
  const SEQUENCE = Object.freeze([
    ['first', 'ban'], ['second', 'ban'], ['first', 'ban'], ['second', 'ban'], ['first', 'ban'], ['second', 'ban'],
    ['first', 'pick'], ['second', 'pick'], ['second', 'pick'], ['first', 'pick'], ['first', 'pick'], ['second', 'pick'],
    ['second', 'ban'], ['first', 'ban'], ['second', 'ban'], ['first', 'ban'],
    ['second', 'pick'], ['first', 'pick'], ['first', 'pick'], ['second', 'pick']
  ]);

  const PHASES = Object.freeze([
    { index: 0, label: '首轮禁用', short: 'BAN 1', start: 0, end: 6, total: 6, firstSide: 'first', type: 'ban' },
    { index: 1, label: '首轮选用', short: 'PICK 1', start: 6, end: 12, total: 6, firstSide: 'first', type: 'pick' },
    { index: 2, label: '次轮禁用', short: 'BAN 2', start: 12, end: 16, total: 4, firstSide: 'second', type: 'ban' },
    { index: 3, label: '次轮选用', short: 'PICK 2', start: 16, end: 20, total: 4, firstSide: 'second', type: 'pick' }
  ]);

  const TURN_SECONDS_MIN = 10;
  const TURN_SECONDS_MAX = 90;

  class DraftError extends Error {
    constructor(message, code) {
      super(message);
      this.name = 'DraftError';
      this.code = code || 'DRAFT_ERROR';
    }
  }

  function otherSide(side) {
    return side === 'blue' ? 'red' : 'blue';
  }

  function otherTeam(teamId) {
    return teamId === 'A' ? 'B' : 'A';
  }

  function clamp(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  }

  function cleanName(value, fallback, maxLength) {
    const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    return text ? text.slice(0, maxLength || 24) : fallback;
  }

  function iso(now) {
    return new Date(now == null ? Date.now() : now).toISOString();
  }

  function createGame(blueTeamId, firstTeamId, now, timerEnabled, turnSeconds) {
    const firstTeam = firstTeamId === 'A' || firstTeamId === 'B' ? firstTeamId : blueTeamId;
    return {
      blueTeam: blueTeamId,
      redTeam: otherTeam(blueTeamId),
      firstTeam: firstTeam,
      secondTeam: otherTeam(firstTeam),
      actions: [],
      startedAt: iso(now),
      completedAt: null,
      deadline: timerEnabled ? (now == null ? Date.now() : now) + turnSeconds * 1000 : null,
      paused: false,
      pausedRemaining: null
    };
  }

  function createSeries(config, now) {
    config = config || {};
    const at = now == null ? Date.now() : now;
    const format = Number(config.format) === 5 ? 5 : 3;
    const targetWins = format === 5 ? 3 : 2;
    const teamA = cleanName(config.teamA, '蓝队', 24);
    const teamB = cleanName(config.teamB, '红队', 24);
    const firstBlue = config.firstBlue === 'B' ? 'B' : 'A';
    const firstPick = config.firstPick === 'B' ? 'B' : config.firstPick === 'A' ? 'A' : firstBlue;
    const mode = config.mode === 'soft' ? 'soft' : 'hard';
    const timerEnabled = config.timerEnabled !== false;
    const turnSeconds = clamp(config.turnSeconds, TURN_SECONDS_MIN, TURN_SECONDS_MAX, 30);

    return {
      version: STATE_VERSION,
      createdAt: iso(at),
      updatedAt: iso(at),
      series: {
        format: format,
        targetWins: targetWins,
        mode: mode,
        timerEnabled: timerEnabled,
        turnSeconds: turnSeconds,
        teams: {
          A: { id: 'A', name: teamA, score: 0 },
          B: { id: 'B', name: teamB, score: 0 }
        },
        gameNo: 1,
        games: [],
        phase: 'drafting',
        current: createGame(firstBlue, firstPick, at, timerEnabled, turnSeconds)
      }
    };
  }

  function touch(state, now) {
    state.updatedAt = iso(now);
    return state;
  }

  function getTurn(state) {
    const series = state.series;
    if (series.phase !== 'drafting') return null;
    const index = series.current.actions.length;
    if (index >= SEQUENCE.length) return null;
    const step = SEQUENCE[index];
    const order = step[0];
    const teamId = series.current[order + 'Team'];
    const side = teamId === series.current.blueTeam ? 'blue' : 'red';
    const phase = PHASES.find(function (p) { return index >= p.start && index < p.end; });
    return {
      index: index,
      number: index + 1,
      total: SEQUENCE.length,
      order: order,
      orderLabel: ORDER_LABEL[order],
      orderShort: ORDER_SHORT[order],
      side: side,
      type: step[1],
      sideLabel: SIDE_LABEL[side],
      typeLabel: TYPE_LABEL[step[1]],
      teamId: teamId,
      teamName: series.teams[teamId].name,
      phase: phase,
      phaseIndex: phase.index,
      phaseTurn: index - phase.start + 1,
      phaseTotal: phase.total
    };
  }

  function getPhaseProgress(state) {
    const taken = state.series.current.actions.length;
    return PHASES.map(function (phase) {
      return {
        index: phase.index,
        label: phase.label,
        short: phase.short,
        type: phase.type,
        start: phase.start,
        end: phase.end,
        total: phase.total,
        taken: Math.max(0, Math.min(phase.total, taken - phase.start)),
        active: taken >= phase.start && taken < phase.end,
        complete: taken >= phase.end
      };
    });
  }

  function actionsFor(game) {
    return game && Array.isArray(game.actions) ? game.actions : [];
  }

  function usedInCurrent(state, champId) {
    return actionsFor(state.series.current).some(function (action) { return action.champId === champId; });
  }

  /**
   * 返回该英雄在已完成小局中的选用记录。
   * 硬性全局：任一记录都会锁定；软性全局：只有本方队伍的记录才锁定。
   */
  function getGlobalEntries(state, champId) {
    const result = [];
    state.series.games.forEach(function (game) {
      SIDES.forEach(function (side) {
        const picked = game.picks && game.picks[side] ? game.picks[side] : [];
        if (picked.indexOf(champId) !== -1) {
          result.push({
            gameNo: game.no,
            side: side,
            teamId: game[side + 'Team'],
            teamName: state.series.teams[game[side + 'Team']].name
          });
        }
      });
    });
    return result;
  }

  function normalizeTeamId(state, value) {
    if (value === 'blue' || value === 'red') return state.series.current[value + 'Team'];
    return value;
  }

  function isGloballyLocked(state, champId, teamId) {
    teamId = normalizeTeamId(state, teamId);
    const entries = getGlobalEntries(state, champId);
    if (state.series.mode === 'hard') return entries.length > 0;
    return entries.some(function (entry) { return entry.teamId === teamId; });
  }

  function getChampionState(state, champId, teamId) {
    teamId = normalizeTeamId(state, teamId);
    if (usedInCurrent(state, champId)) {
      const action = state.series.current.actions.find(function (item) { return item.champId === champId; });
      return {
        available: false,
        reason: action && action.type === 'ban' ? '本局已禁用' : '本局已选用',
        action: action
      };
    }
    const entries = getGlobalEntries(state, champId);
    if (entries.length) {
      const locked = isGloballyLocked(state, champId, teamId);
      if (locked) {
        return {
          available: false,
          reason: '全局已选用 · G' + entries[0].gameNo,
          entries: entries
        };
      }
    }
    return { available: true, reason: '', entries: entries };
  }

  function applyAction(state, champId, now) {
    const series = state.series;
    const turn = getTurn(state);
    if (!turn) {
      if (series.phase === 'review') throw new DraftError('本局 BP 已完成，请先确认赛果', 'COMPLETE');
      if (series.phase === 'between') throw new DraftError('请先开始下一局', 'BETWEEN');
      if (series.phase === 'finished') throw new DraftError('系列赛已经结束', 'FINISHED');
      throw new DraftError('当前不在 BP 阶段', 'NOT_DRAFTING');
    }
    if (typeof champId !== 'string' || !champId) throw new DraftError('请选择英雄', 'NO_CHAMPION');
    if (usedInCurrent(state, champId)) {
      throw new DraftError('该英雄本局已被禁用或选用', 'ALREADY_USED');
    }
    if (isGloballyLocked(state, champId, turn.teamId)) {
      const entry = getGlobalEntries(state, champId)[0];
      throw new DraftError('该英雄已在第 ' + entry.gameNo + ' 局选用，全局 BP 中不可再选', 'GLOBAL_LOCKED');
    }

    series.current.actions.push({
      side: turn.side,
      order: turn.order,
      type: turn.type,
      champId: champId,
      teamId: turn.teamId,
      at: iso(now),
      turn: turn.index + 1
    });
    series.current.paused = false;
    series.current.pausedRemaining = null;
    series.current.deadline = series.timerEnabled
      ? (now == null ? Date.now() : now) + series.turnSeconds * 1000
      : null;

    if (series.current.actions.length >= SEQUENCE.length) {
      series.phase = 'review';
      series.current.completedAt = iso(now);
      series.current.deadline = null;
    }
    return touch(state, now);
  }

  function undoAction(state, now) {
    const series = state.series;
    if (series.phase !== 'drafting' && series.phase !== 'review') {
      throw new DraftError('当前不可撤销', 'CANNOT_UNDO');
    }
    if (!series.current.actions.length) throw new DraftError('没有可撤销的操作', 'NOTHING_TO_UNDO');
    series.current.actions.pop();
    series.current.completedAt = null;
    series.phase = 'drafting';
    series.current.paused = false;
    series.current.pausedRemaining = null;
    series.current.deadline = series.timerEnabled
      ? (now == null ? Date.now() : now) + series.turnSeconds * 1000
      : null;
    return touch(state, now);
  }

  function pauseTimer(state, now) {
    const current = state.series.current;
    if (state.series.phase !== 'drafting' || !state.series.timerEnabled || current.paused || current.deadline == null) {
      return state;
    }
    const at = now == null ? Date.now() : now;
    current.pausedRemaining = Math.max(0, current.deadline - at);
    current.paused = true;
    current.deadline = null;
    return touch(state, now);
  }

  function resumeTimer(state, now) {
    const current = state.series.current;
    if (state.series.phase !== 'drafting' || !state.series.timerEnabled || !current.paused) return state;
    const at = now == null ? Date.now() : now;
    current.deadline = at + (current.pausedRemaining == null ? state.series.turnSeconds * 1000 : current.pausedRemaining);
    current.paused = false;
    current.pausedRemaining = null;
    return touch(state, now);
  }

  function setTimerEnabled(state, enabled, now) {
    const series = state.series;
    series.timerEnabled = !!enabled;
    const current = series.current;
    if (!series.timerEnabled) {
      current.paused = false;
      current.pausedRemaining = null;
      current.deadline = null;
    } else if (series.phase === 'drafting') {
      current.paused = false;
      current.pausedRemaining = null;
      current.deadline = (now == null ? Date.now() : now) + series.turnSeconds * 1000;
    }
    return touch(state, now);
  }

  function swapCurrentSides(state, now) {
    const series = state.series;
    if (series.phase !== 'drafting' || series.current.actions.length) {
      throw new DraftError('只能在 BP 开始前交换阵营', 'SIDES_LOCKED');
    }
    const blue = series.current.blueTeam;
    series.current.blueTeam = series.current.redTeam;
    series.current.redTeam = blue;
    series.current.paused = false;
    series.current.pausedRemaining = null;
    series.current.deadline = series.timerEnabled ? (now == null ? Date.now() : now) + series.turnSeconds * 1000 : null;
    return touch(state, now);
  }

  function swapDraftOrder(state, now) {
    const series = state.series;
    if (series.phase !== 'drafting' || series.current.actions.length) {
      throw new DraftError('只能在 BP 开始前交换 BP 顺序', 'ORDER_LOCKED');
    }
    const first = series.current.firstTeam;
    series.current.firstTeam = series.current.secondTeam;
    series.current.secondTeam = first;
    series.current.paused = false;
    series.current.pausedRemaining = null;
    series.current.deadline = series.timerEnabled ? (now == null ? Date.now() : now) + series.turnSeconds * 1000 : null;
    return touch(state, now);
  }

  function summarizeActions(actions) {
    const picks = { blue: [], red: [] };
    const bans = { blue: [], red: [] };
    actions.forEach(function (action) {
      const target = action.type === 'pick' ? picks : bans;
      target[action.side].push(action.champId);
    });
    return { picks: picks, bans: bans };
  }

  function completeGame(state, winnerTeamId, now) {
    const series = state.series;
    if (series.phase !== 'review') throw new DraftError('请先完成本局 BP', 'NOT_REVIEW');
    const current = series.current;
    if (current.actions.length !== SEQUENCE.length) throw new DraftError('BP 尚未完成', 'INCOMPLETE');
    if (winnerTeamId !== current.blueTeam && winnerTeamId !== current.redTeam) {
      throw new DraftError('请选择本局胜者', 'NO_WINNER');
    }
    const groups = summarizeActions(current.actions);
    const game = {
      no: series.gameNo,
      blueTeam: current.blueTeam,
      redTeam: current.redTeam,
      firstTeam: current.firstTeam,
      secondTeam: current.secondTeam,
      winnerTeamId: winnerTeamId,
      winnerSide: winnerTeamId === current.blueTeam ? 'blue' : 'red',
      picks: groups.picks,
      bans: groups.bans,
      actions: current.actions.slice(),
      startedAt: current.startedAt,
      completedAt: iso(now)
    };
    series.games.push(game);
    series.teams[winnerTeamId].score += 1;
    series.phase = series.teams[winnerTeamId].score >= series.targetWins ? 'finished' : 'between';
    current.deadline = null;
    current.paused = false;
    current.pausedRemaining = null;
    return touch(state, now);
  }

  function startNextGame(state, selection, now) {
    const series = state.series;
    if (series.phase !== 'between') throw new DraftError('当前不能开始下一局', 'NOT_BETWEEN');
    let blueTeamId;
    let firstTeamId;
    if (typeof selection === 'string') {
      blueTeamId = selection;
      firstTeamId = selection;
    } else {
      selection = selection || {};
      blueTeamId = selection.blueTeam;
      firstTeamId = selection.firstTeam;
    }
    if (blueTeamId !== 'A' && blueTeamId !== 'B') blueTeamId = series.current.blueTeam;
    if (firstTeamId !== 'A' && firstTeamId !== 'B') firstTeamId = blueTeamId;
    if (series.games.length >= series.format) throw new DraftError('系列赛已达到最大局数', 'MAX_GAMES');
    series.gameNo += 1;
    series.current = createGame(blueTeamId, firstTeamId, now, series.timerEnabled, series.turnSeconds);
    series.phase = 'drafting';
    return touch(state, now);
  }

  function resetCurrentGame(state, now) {
    const series = state.series;
    if (series.phase !== 'drafting' && series.phase !== 'review') {
      throw new DraftError('当前不可重置本局', 'CANNOT_RESET');
    }
    series.current.actions = [];
    series.current.completedAt = null;
    series.current.paused = false;
    series.current.pausedRemaining = null;
    series.current.deadline = series.timerEnabled ? (now == null ? Date.now() : now) + series.turnSeconds * 1000 : null;
    series.phase = 'drafting';
    return touch(state, now);
  }

  function getGlobalPool(state) {
    const entries = [];
    state.series.games.forEach(function (game) {
      SIDES.forEach(function (side) {
        (game.picks[side] || []).forEach(function (champId) {
          entries.push({
            champId: champId,
            gameNo: game.no,
            side: side,
            teamId: game[side + 'Team'],
            teamName: state.series.teams[game[side + 'Team']].name
          });
        });
      });
    });
    return entries;
  }

  function getSeriesStatus(state) {
    const series = state.series;
    const a = series.teams.A;
    const b = series.teams.B;
    let leader = null;
    if (a.score > b.score) leader = 'A';
    if (b.score > a.score) leader = 'B';
    return {
      phase: series.phase,
      phaseLabel: PHASE_LABEL[series.phase],
      score: { A: a.score, B: b.score },
      leader: leader,
      gameNo: series.gameNo,
      targetWins: series.targetWins,
      formatLabel: 'BO' + series.format,
      modeLabel: MODE_LABEL[series.mode],
      champion: series.phase === 'finished' ? (a.score > b.score ? a : b) : null,
      canStartNext: series.phase === 'between',
      isCompleteDraft: series.phase === 'review'
    };
  }

  function getGameResultLabel(state, game) {
    const winner = state.series.teams[game.winnerTeamId];
    return winner ? winner.name + ' 胜' : '';
  }

  function buildReport(state, nameOf) {
    const series = state.series;
    const a = series.teams.A;
    const b = series.teams.B;
    const name = function (id) { return nameOf ? nameOf(id) : id; };
    const lines = [];
    lines.push('【无畏征召 · 全局 BP】' + a.name + ' ' + a.score + ' : ' + b.score + ' ' + b.name);
    lines.push('赛制：BO' + series.format + ' · ' + MODE_LABEL[series.mode] + ' · 数据 16.21.1');
    if (series.phase === 'finished') lines.push('结果：' + (a.score > b.score ? a.name : b.name) + ' 赢得系列赛');
    else lines.push('进度：第 ' + series.gameNo + ' 局 · ' + PHASE_LABEL[series.phase]);
    lines.push('');

    series.games.forEach(function (game) {
      const blue = series.teams[game.blueTeam];
      const red = series.teams[game.redTeam];
      lines.push('第 ' + game.no + ' 局 · 蓝方 ' + blue.name + ' vs 红方 ' + red.name + ' · BP先选 ' + series.teams[game.firstTeam].name + ' · ' + series.teams[game.winnerTeamId].name + ' 胜');
      lines.push('  蓝方禁用：' + (game.bans.blue.map(name).join('、') || '—'));
      lines.push('  蓝方选用：' + (game.picks.blue.map(name).join('、') || '—'));
      lines.push('  红方禁用：' + (game.bans.red.map(name).join('、') || '—'));
      lines.push('  红方选用：' + (game.picks.red.map(name).join('、') || '—'));
      lines.push('');
    });

    if (series.phase === 'review') {
      const groups = summarizeActions(series.current.actions);
      lines.push('第 ' + series.gameNo + ' 局（待确认赛果） · BP先选 ' + series.teams[series.current.firstTeam].name);
      lines.push('  蓝方选用：' + groups.picks.blue.map(name).join('、'));
      lines.push('  红方选用：' + groups.picks.red.map(name).join('、'));
      lines.push('');
    }

    const pool = getGlobalPool(state);
    const unique = [];
    const seen = {};
    pool.forEach(function (entry) {
      if (!seen[entry.champId]) {
        seen[entry.champId] = true;
        unique.push(entry);
      }
    });
    lines.push('全局已用英雄（' + unique.length + '）：' + (unique.map(function (entry) { return name(entry.champId); }).join('、') || '—'));
    lines.push('规则：仅选用英雄进入全局池；禁用不继承。');
    return lines.join('\n');
  }

  function validateState(state) {
    if (!state || typeof state !== 'object') return false;
    if (state.version !== STATE_VERSION) return false;
    const series = state.series;
    if (!series || !series.teams || !series.teams.A || !series.teams.B) return false;
    if (series.format !== 3 && series.format !== 5) return false;
    if (series.mode !== 'hard' && series.mode !== 'soft') return false;
    if (!Array.isArray(series.games)) return false;
    if (!series.current || !Array.isArray(series.current.actions)) return false;
    if (['drafting', 'review', 'between', 'finished'].indexOf(series.phase) === -1) return false;
    if (series.current.actions.length > SEQUENCE.length) return false;
    if (series.current.blueTeam !== 'A' && series.current.blueTeam !== 'B') return false;
    if (series.current.redTeam !== 'A' && series.current.redTeam !== 'B') return false;
    if (series.current.blueTeam === series.current.redTeam) return false;
    if (series.current.firstTeam !== 'A' && series.current.firstTeam !== 'B') return false;
    if (series.current.secondTeam !== 'A' && series.current.secondTeam !== 'B') return false;
    if (series.current.firstTeam === series.current.secondTeam) return false;
    if (series.gameNo < 1 || series.gameNo > series.format) return false;
    if (series.games.length > series.format) return false;
    if ((series.phase === 'review') !== (series.current.actions.length === SEQUENCE.length)) {
      if (!(series.phase === 'between' || series.phase === 'finished')) return false;
    }

    const seen = {};
    for (let i = 0; i < series.current.actions.length; i++) {
      const action = series.current.actions[i];
      const expected = SEQUENCE[i];
      if (!action || action.order !== expected[0] || action.type !== expected[1]) return false;
      if (action.teamId !== series.current[action.order + 'Team']) return false;
      const expectedSide = action.teamId === series.current.blueTeam ? 'blue' : 'red';
      if (action.side !== expectedSide) return false;
      if (typeof action.champId !== 'string' || seen[action.champId]) return false;
      seen[action.champId] = true;
    }

    const scores = { A: 0, B: 0 };
    for (let i = 0; i < series.games.length; i++) {
      const game = series.games[i];
      if (!game || !game.picks || !game.bans) return false;
      if ((game.blueTeam !== 'A' && game.blueTeam !== 'B') || (game.redTeam !== 'A' && game.redTeam !== 'B')) return false;
      if ((game.firstTeam !== 'A' && game.firstTeam !== 'B') || (game.secondTeam !== 'A' && game.secondTeam !== 'B')) return false;
      if (game.firstTeam === game.secondTeam) return false;
      if (game.firstTeam !== game.blueTeam && game.firstTeam !== game.redTeam) return false;
      if (game.winnerTeamId !== game.blueTeam && game.winnerTeamId !== game.redTeam) return false;
      if (!Array.isArray(game.picks.blue) || !Array.isArray(game.picks.red)) return false;
      if (game.picks.blue.length !== 5 || game.picks.red.length !== 5) return false;
      scores[game.winnerTeamId] += 1;
    }
    if (series.teams.A.score !== scores.A || series.teams.B.score !== scores.B) return false;
    return true;
  }

  return {
    STATE_VERSION: STATE_VERSION,
    SIDES: SIDES,
    SIDE_LABEL: SIDE_LABEL,
    SIDE_SHORT: SIDE_SHORT,
    ORDER_LABEL: ORDER_LABEL,
    ORDER_SHORT: ORDER_SHORT,
    TYPE_LABEL: TYPE_LABEL,
    MODE_LABEL: MODE_LABEL,
    PHASE_LABEL: PHASE_LABEL,
    SEQUENCE: SEQUENCE,
    PHASES: PHASES,
    TURN_SECONDS_MIN: TURN_SECONDS_MIN,
    TURN_SECONDS_MAX: TURN_SECONDS_MAX,
    DraftError: DraftError,
    createSeries: createSeries,
    getTurn: getTurn,
    getPhaseProgress: getPhaseProgress,
    getGlobalEntries: getGlobalEntries,
    isGloballyLocked: isGloballyLocked,
    getChampionState: getChampionState,
    applyAction: applyAction,
    undoAction: undoAction,
    pauseTimer: pauseTimer,
    resumeTimer: resumeTimer,
    setTimerEnabled: setTimerEnabled,
    swapCurrentSides: swapCurrentSides,
    swapDraftOrder: swapDraftOrder,
    summarizeActions: summarizeActions,
    completeGame: completeGame,
    startNextGame: startNextGame,
    resetCurrentGame: resetCurrentGame,
    getGlobalPool: getGlobalPool,
    getSeriesStatus: getSeriesStatus,
    getGameResultLabel: getGameResultLabel,
    buildReport: buildReport,
    validateState: validateState
  };
});

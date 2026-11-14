import { describe, expect, it } from 'vitest';
import { startRealtime, tickRealtime } from '../web/realtime-core.js';
import { HOUSE_01 } from '../src/levels.js';
const level = { id:'test', name:'test', rows:['########','#S....E#','#..H...#','#R.....#','########'], residentPath:[[5,1],[5,2],[5,3],[4,3],[3,3],[2,3],[1,3],[1,2],[1,1],[2,1],[3,1],[4,1]], residentEvery:2, sight:4, linger:4 };
describe('real-time stealth', () => {
  it('keeps one resident by the TV while the other visits and pauses at the fridge', () => {
    let s = startRealtime(HOUSE_01);
    s.player = { x: 1, y: 8 };
    const visited: string[] = [];
    for (let i = 0; i < 75; i++) {
      s = tickRealtime(HOUSE_01, s, {});
      expect([s.resident.x, s.resident.y]).toEqual(HOUSE_01.routines!.tv);
      visited.push(`${s.secondResident!.x},${s.secondResident!.y}`);
    }
    expect(visited).toContain('10,7');
    expect(visited.filter(p => p === '10,7').length).toBeGreaterThanOrEqual(12);
    expect(visited.indexOf('7,7')).toBeLessThan(visited.indexOf('10,7'));
    expect(visited.lastIndexOf('7,8')).toBeGreaterThan(visited.indexOf('10,7'));
  });
  it('advances guards while the player stands still', () => {
    let s=startRealtime(level); const before={...s.resident};
    for(let i=0;i<3;i++)s=tickRealtime(level,s,{});
    expect([s.resident.x,s.resident.y]).not.toEqual([before.x,before.y]);
  });
  it('sprints faster than walking, consuming stamina', () => {
    let walking=startRealtime(level),running=startRealtime(level);
    for(let i=0;i<2;i++){walking=tickRealtime(level,walking,{direction:'right'});running=tickRealtime(level,running,{direction:'right',sprint:true})}
    expect(running.player.x).toBeGreaterThan(walking.player.x);expect(running.stamina).toBe(13);
  });
  it('starts pursuit when seen and catches only on contact', () => {
    let s=startRealtime(level);s.player={x:3,y:1};s.resident={...s.resident,x:5,y:1,facing:'left'};
    s=tickRealtime(level,s,{});expect(s.resident.mode).toBe('chase');expect(s.status).toBe('playing');
    for(let i=0;i<8&&s.status==='playing';i++)s=tickRealtime(level,s,{});
    expect(s.status).toBe('caught');
  });
  it('hides the player on cover tiles and collects loot automatically', () => {
    let s=startRealtime(level);s.player={x:3,y:2};s.resident={...s.resident,x:5,y:2,facing:'left'};
    s=tickRealtime(level,s,{});expect(s.hidden).toBe(true);expect(s.resident.mode).toBe('patrol');
    s=startRealtime(level);s.player={x:1,y:3};s=tickRealtime(level,s,{});expect(s.ram[0].taken).toBe(true);
  });
});

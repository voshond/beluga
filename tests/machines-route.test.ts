import { describe, expect, it } from 'vitest';
import { demoMachines } from '../src/machines/demo.js';
import { projectThere, routeWork } from '../src/machines/route.js';

/**
 * Start the work on that computer (BLG-788): Runs on's pick made concrete (this Mac, or a computer
 * that can take it now), and the project there found by its origin, else its name, else to be made
 * ready first.
 */

const [mini, aws] = demoMachines({ projects: [] }, Date.now());
const machines = [mini!, aws!];
const base = { machines, hereName: 'This Mac', runtime: 'claude' };

describe('where new work goes', () => {
  it('here stays here', () => {
    expect(routeWork({ ...base, runsOn: 'here' })).toEqual({ where: 'here' });
  });

  it('a computer by name, with its project there by origin', () => {
    const route = routeWork({ ...base, runsOn: aws!.id, project: { name: 'api', origin: 'https://github.com/kayraucklnc/bob-api' } });
    expect(route).toMatchObject({ where: 'computer', project: 'bob-api' });
    expect(route.where === 'computer' && route.machine.id).toBe(aws!.id);
  });

  it('a project the computer doesn’t have: to be made ready there first', () => {
    const route = routeWork({ ...base, runsOn: aws!.id, project: { name: 'landing', origin: 'git@github.com:kayraucklnc/landing.git' } });
    expect(route).toMatchObject({ where: 'computer' });
    expect(route.where === 'computer' && route.project).toBeUndefined();
  });

  it('a computer that can’t run it now (Codex signed out there) runs here, said in words', () => {
    const route = routeWork({ ...base, runtime: 'codex', runsOn: aws!.id });
    expect(route).toEqual({ where: 'here', why: 'build-box can’t run it now (codex isn’t signed in there), so it runs on This Mac.' });
  });

  it('an offline one runs here', () => {
    const route = routeWork({ ...base, runsOn: aws!.id, machines: [mini!, { ...aws!, status: 'offline' }] });
    expect(route.where).toBe('here');
  });

  it('Best Available picks one and says why', () => {
    const route = routeWork({ ...base, runsOn: 'best', project: { name: 'landing' } });
    expect(route).toMatchObject({ where: 'computer', project: 'landing' });
    expect(route.why).toMatch(/has /);
  });

  it('finds the project by origin, else by name', () => {
    expect(projectThere(mini!, { name: 'whatever', origin: 'git@github.com:kayraucklnc/landing.git' })).toBe('landing');
    expect(projectThere(mini!, { name: 'landing' })).toBe('landing');
    expect(projectThere(aws!, { name: 'landing' })).toBeUndefined();
  });
});

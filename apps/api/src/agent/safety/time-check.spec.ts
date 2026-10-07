import { timesIn, unsupportedTimes } from './time-check.js';

describe('timesIn', () => {
  it.each([
    ['10:00 AM', [600]],
    ['10:00am', [600]],
    ['10 a.m.', [600]],
    ['2:30 PM', [870]],
    ['12:00 PM', [720]],
    ['12:15 AM', [15]],
    ['14:30', [870]],
    ['09:00', [540]],
    ['2:00', [120, 840]], // without AM or PM it may mean either
    ['0:30', [30]],
  ])('reads %j as %j minutes after midnight', (text, minutes) => {
    expect(timesIn(`See you at ${text} then.`).map((time) => time.minutes)).toEqual([minutes]);
  });

  it.each([['We have 3 options.'], ['born in 1991'], ['call +1 415 555 0123'], ['room 12'], ['25:00'], ['13 pm'], ['10:75'], ['on 5 October']])('finds no time in %j', (text) => {
    expect(timesIn(text)).toEqual([]);
  });
});

describe('unsupportedTimes', () => {
  const offered = 'S1 = Monday 5 October at 9:00 AM with Dr Lee; S2 = Monday 5 October at 2:30 PM with Dr Khan';

  it('accepts times that were offered, however they are written', () => {
    expect(unsupportedTimes('I have Monday at 9:00 AM or 2:30 PM. Which would you like?', offered)).toEqual([]);
    expect(unsupportedTimes('How about 9 am?', offered)).toEqual([]);
    expect(unsupportedTimes('Shall I take 14:30?', offered)).toEqual([]);
  });

  it('finds times the model made up', () => {
    expect(unsupportedTimes('The available times are Monday at 10:00 AM, Tuesday at 2:00 PM, and Thursday at 9:00 AM.', offered)).toEqual(['10:00 AM', '2:00 PM']);
  });

  it('accepts opening hours from a tool result and times the caller said', () => {
    expect(unsupportedTimes('We are open from 9:00 to 17:00.', 'hoursText: Monday to Friday, 09:00 to 17:00')).toEqual([]);
    expect(unsupportedTimes('You asked about 4 pm: I do not have that time.', 'Caller: can I come at 4 pm?')).toEqual([]);
  });

  it('has nothing to check in a reply without times', () => {
    expect(unsupportedTimes('Which day suits you?', '')).toEqual([]);
  });
});

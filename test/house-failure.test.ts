import { expect, it } from 'vitest';
import { housePublisherFailure, retainHouseFailure } from '../services/house/failure';

const listing = 'https://www.ourcommons.ca/Committees/en/Participate';
const study = 'https://www.ourcommons.ca/committees/fr/HESA/StudyActivity?studyActivityId=13632808';
const refused = { phase: 'acquisition', code: 'publisher-http', status: 403, url: listing } as const;
const response = (body: unknown, status = 403) => Response.json(body, {status});

it('classifies only explicit upstream refusals for required House sources', async () => {
  for (const url of [listing,study]) {
    expect(await housePublisherFailure(response({...refused,url}))).toEqual({...refused,url});
  }
  for (const other of [
    new Response('403 Forbidden', {status:403}),
    new Response('{', {status:403,headers:{'content-type':'application/json'}}),
    response(refused,502), response({...refused,status:429}), response({...refused,phase:'publication'}),
    response({...refused,body:'publisher content'}), response({...refused,url:listing+'?token=private'}),
    response({...refused,url:study.replace('www.ourcommons.ca','sencanada.ca')}),
  ]) expect(await housePublisherFailure(other)).toBeNull();
});

it('retains the exact refusal once without changing the original or a completion receipt', async () => {
  const scheduledTime = Date.UTC(2026,10,25,12,0,0);
  const instance = 'house-calls-' + scheduledTime;
  const completion = 'committee/house-calls/runs/' + instance + '.json';
  const objects = new Map([[completion,'original completion']]);
  const bucket = {
    async put(key: string, value: string, options: R2PutOptions) {
      expect(options.onlyIf).toEqual({etagDoesNotMatch:'*'});
      if (objects.has(key)) return null;
      objects.set(key,value);
      return {key};
    },
    async get(key: string) {
      const value = objects.get(key);
      return value === undefined ? null : {text: async () => value};
    },
  };
  const key = await retainHouseFailure(bucket,instance,scheduledTime,refused);
  expect(key).toBe('committee/house-calls/failures/' + instance + '.json');
  expect(await retainHouseFailure(bucket,instance,scheduledTime,refused)).toBe(key);
  await expect(retainHouseFailure(bucket,instance,scheduledTime,{...refused,url:study})).rejects.toThrow('Conflicting');
  await expect(retainHouseFailure(bucket,instance,scheduledTime+1,refused)).rejects.toThrow();
  expect(objects.size).toBe(2);
  expect(objects.get(completion)).toBe('original completion');
  expect(JSON.parse(objects.get(key) ?? '{}')).toEqual({instanceId:instance,scheduledTime,...refused});
});

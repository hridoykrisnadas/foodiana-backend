import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../dist/db/client.js';
import { runMigrations } from '../dist/db/migrate.js';
import { admitVisitor, exitVisitor } from '../dist/db/gate.js';

const silent = { info() {}, error() {} };

async function seedVisitor(overrides = {}) {
  const id = randomUUID();
  await db
    .insertInto('visitors')
    .values({
      id,
      qr_code_id: `FDL-${id.slice(0, 8).toUpperCase()}`,
      name: 'Test Visitor',
      email: 'test@example.com',
      mobile: '01700000000',
      dob: '1995-01-01',
      profession: 'Tester',
      payment_status: 'Pending',
      entry_status: false,
      exited_status: false,
      includes_concert: false,
      ...overrides,
    })
    .execute();
  return id;
}

async function setCapacity(capacity) {
  await db.updateTable('event_settings').set({ ground_capacity: capacity }).where('id', '=', 1).execute();
}

async function countInside() {
  const { inside } = await db
    .selectFrom('visitors')
    .select((eb) => eb.fn.countAll().as('inside'))
    .where('entry_status', '=', true)
    .where('exited_status', '=', false)
    .executeTakeFirstOrThrow();
  return Number(inside);
}

test.before(async () => {
  await runMigrations(silent);
});

test.beforeEach(async () => {
  await db.deleteFrom('visitors').execute();
  await setCapacity(2000);
});

test('admits a visitor and reports occupancy', async () => {
  const id = await seedVisitor();
  const outcome = await admitVisitor(id, 'Cash');
  assert.equal(outcome.status, 'admitted');
  assert.equal(outcome.inside_now, 1);
  assert.equal(outcome.visitor.entry_status, true);
  assert.equal(outcome.visitor.payment_status, 'Paid');
  assert.equal(outcome.visitor.payment_method, 'Cash');
});

test('rejects a second admission of the same visitor', async () => {
  const id = await seedVisitor({ entry_status: true });
  assert.equal((await admitVisitor(id)).status, 'already_inside');
});

test('rejects admission of someone who already left', async () => {
  const id = await seedVisitor({ entry_status: true, exited_status: true });
  assert.equal((await admitVisitor(id)).status, 'already_exited');
});

test('reports not_found for an unknown id', async () => {
  assert.equal((await admitVisitor(randomUUID())).status, 'not_found');
});

test('refuses admission once the venue is full', async () => {
  await setCapacity(1);
  await seedVisitor({ entry_status: true });
  const outcome = await admitVisitor(await seedVisitor());
  assert.equal(outcome.status, 'capacity_full');
  assert.equal(outcome.capacity, 1);
});

test('exit requires a prior entry', async () => {
  const id = await seedVisitor();
  assert.equal((await exitVisitor(id)).status, 'not_entered');
});

test('exit frees a slot', async () => {
  const id = await seedVisitor();
  await admitVisitor(id);
  const outcome = await exitVisitor(id);
  assert.equal(outcome.status, 'exited');
  assert.equal(outcome.inside_now, 0);
  assert.equal(outcome.visitor.exited_status, true);
});

test('a visitor cannot exit twice', async () => {
  const id = await seedVisitor({ entry_status: true, exited_status: true });
  assert.equal((await exitVisitor(id)).status, 'already_exited');
});

/*
 * The test that matters.
 *
 * Without the FOR UPDATE row lock in admitVisitor, every one of these concurrent
 * transactions reads the same occupancy, every one passes the capacity check,
 * and the venue is oversold. With it, they serialise and exactly one wins.
 *
 * If this ever passes with the lock removed, it has stopped testing anything.
 */
test('exactly one admission wins the last slot under concurrency', async () => {
  const CAPACITY = 5;
  await setCapacity(CAPACITY);

  for (let i = 0; i < CAPACITY - 1; i += 1) {
    await seedVisitor({ entry_status: true });
  }
  assert.equal(await countInside(), CAPACITY - 1, 'seeding is wrong');

  const contenders = [];
  for (let i = 0; i < 20; i += 1) contenders.push(await seedVisitor());

  const outcomes = await Promise.all(contenders.map((id) => admitVisitor(id)));

  const admitted = outcomes.filter((o) => o.status === 'admitted');
  const full = outcomes.filter((o) => o.status === 'capacity_full');

  assert.equal(admitted.length, 1, `expected exactly 1 admission, got ${admitted.length}`);
  assert.equal(full.length, 19, `expected 19 rejections, got ${full.length}`);
  assert.equal(await countInside(), CAPACITY, 'occupancy exceeded capacity');
});

test('concurrent exits do not undercount occupancy', async () => {
  const ids = [];
  for (let i = 0; i < 10; i += 1) ids.push(await seedVisitor({ entry_status: true }));

  const outcomes = await Promise.all(ids.map((id) => exitVisitor(id)));
  assert.equal(outcomes.filter((o) => o.status === 'exited').length, 10);
  assert.equal(await countInside(), 0);
});

test.after(async () => {
  await db.destroy();
});

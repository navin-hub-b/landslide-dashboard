import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldNotify,
  evaluateAndNotify,
  sendTestAlert,
  smsStatusSummary,
  sendSimulatedSms,
} from '../server/modules/notifications.js';
import { store } from '../server/store.js';

describe('Emergency Notifications & Alert Dispatcher (server/modules/notifications.js)', () => {
  beforeEach(() => {
    store._resetForTests();
  });

  describe('shouldNotify() logic', () => {
    test('SAFE status never triggers emergency notification', () => {
      const res = shouldNotify('SAFE', 'SAFE', 15);
      assert.equal(res.shouldSend, false);
      assert.equal(res.isEscalation, false);
      assert.equal(res.isRecovery, false);
    });

    test('escalation from SAFE or WARNING to DANGER always fires immediately', () => {
      const res1 = shouldNotify('DANGER', 'SAFE', 15);
      assert.equal(res1.shouldSend, true);
      assert.equal(res1.isEscalation, true);
      assert.equal(res1.isRecovery, false);

      const res2 = shouldNotify('DANGER', 'WARNING', 15);
      assert.equal(res2.shouldSend, true);
      assert.equal(res2.isEscalation, true);
    });

    test('repeated identical status within cooldown is suppressed', () => {
      store.recordAlertSent('DANGER');
      const res = shouldNotify('DANGER', 'DANGER', 15);
      assert.equal(res.shouldSend, false);
      assert.equal(res.isEscalation, false);
      assert.ok(res.reason.includes('cooldown'));
    });

    test('recovery transition from DANGER to SAFE is flagged as recovery and never sends SMS', () => {
      const res = shouldNotify('SAFE', 'DANGER', 15);
      assert.equal(res.shouldSend, false);
      assert.equal(res.isRecovery, true);
      assert.equal(res.isEscalation, false);
    });
  });

  describe('evaluateAndNotify() workflow', () => {
    test('first DANGER triggers a notification and registers in audit log', async () => {
      // Register a consenting recipient
      store.setRecipientConsent({
        phone: '+919876543210',
        consentGiven: true,
      });

      const riskAssessment = {
        totalScore: 12,
        status: 'DANGER',
        notes: ['Critical displacement', 'High soil moisture'],
      };

      const res = await evaluateAndNotify(riskAssessment);
      assert.equal(res.notified, true);
      assert.equal(res.status, 'DANGER');
      assert.equal(res.isEscalation, true);
      assert.equal(res.recipientsNotified, 1);
      assert.equal(res.deliveries[0].provider, 'simulated');

      // Verify audit log has emergency alert recorded
      const log = store.getAlertLog();
      assert.ok(log.length >= 1);
      const entry = log[log.length - 1];
      assert.equal(entry.status, 'DANGER');
      assert.ok(entry.message.includes('CRITICAL LANDSLIDE DANGER'));
    });

    test('repeated DANGER within cooldown is deduplicated', async () => {
      store.setRecipientConsent({
        phone: '+919876543210',
        consentGiven: true,
      });

      const riskAssessment = {
        totalScore: 12,
        status: 'DANGER',
      };

      // First run: fires alert
      const first = await evaluateAndNotify(riskAssessment);
      assert.equal(first.notified, true);

      // Second run: suppressed by cooldown
      const second = await evaluateAndNotify(riskAssessment);
      assert.equal(second.notified, false);
      assert.equal(second.suppressed, true);
      assert.ok(second.reason.includes('cooldown'));

      // Verify audit log has DEDUP_SUPPRESSED recorded
      const log = store.getAlertLog();
      const suppressedEntry = log[log.length - 1];
      assert.equal(suppressedEntry.type, 'DEDUP_SUPPRESSED');
    });

    test('escalation is not suppressed by cooldown', async () => {
      store.setRecipientConsent({ phone: '+919876543210', consentGiven: true });

      // Send initial HIGH_RISK alert
      const first = await evaluateAndNotify({ totalScore: 8, status: 'HIGH_RISK' });
      assert.equal(first.notified, true);
      assert.equal(first.status, 'HIGH_RISK');

      // Immediate escalation to DANGER -> must bypass cooldown and fire immediately
      const escalated = await evaluateAndNotify({ totalScore: 12, status: 'DANGER' });
      assert.equal(escalated.notified, true);
      assert.equal(escalated.status, 'DANGER');
      assert.equal(escalated.isEscalation, true);
    });

    test('recovery is logged without erasing prior alerts', async () => {
      store.setRecipientConsent({
        phone: '+919876543210',
        consentGiven: true,
      });

      // 1. Escalate to DANGER
      await evaluateAndNotify({ totalScore: 12, status: 'DANGER' });
      const logsAfterDanger = store.getAlertLog();
      assert.ok(logsAfterDanger.length >= 1);

      // 2. Recover to SAFE
      const recoveryRes = await evaluateAndNotify({ totalScore: 0, status: 'SAFE' });
      assert.equal(recoveryRes.notified, false);
      assert.equal(recoveryRes.isRecovery, true);

      // 3. Verify prior DANGER alert is preserved, and RECOVERY entry is appended
      const logsAfterRecovery = store.getAlertLog();
      assert.ok(logsAfterRecovery.length >= 2);
      assert.ok(logsAfterRecovery.some((e) => e.status === 'DANGER'));
      const latestLog = logsAfterRecovery[logsAfterRecovery.length - 1];
      assert.equal(latestLog.type, 'RECOVERY');
      assert.equal(latestLog.status, 'SAFE');
    });

    test('missing recipient skips SMS without fabricating success', async () => {
      // Ensure no recipients are registered
      store.clearRecipientConsent();

      const riskAssessment = {
        totalScore: 14,
        status: 'DANGER',
      };

      const res = await evaluateAndNotify(riskAssessment);
      assert.equal(res.notified, false);
      assert.equal(res.recipientsNotified, 0);
      assert.equal(res.deliveries.length, 0);
      assert.equal(res.skipped, true);
      assert.ok(res.reason.includes('skipped'));

      // Ensure alert is recorded in audit log noting skipped SMS
      const log = store.getAlertLog();
      const lastEntry = log[log.length - 1];
      assert.equal(lastEntry.status, 'DANGER');
      assert.ok(lastEntry.message.includes('SMS skipped'));
    });
  });

  describe('sendTestAlert() safety policy', () => {
    test('sendTestAlert defaults to simulated and refuses without a consenting recipient', async () => {
      store.clearRecipientConsent();

      // Refuses when no consenting recipient is present
      const refusedRes = await sendTestAlert();
      assert.equal(refusedRes.success, false);
      assert.equal(refusedRes.refused, true);
      assert.equal(refusedRes.simulated, true);
      assert.ok(refusedRes.error.includes('No consenting recipient'));

      // Registers a consenting recipient and succeeds with simulated default
      store.setRecipientConsent({
        phone: '+919876543210',
        consentGiven: true,
      });

      const res = await sendTestAlert({ customNote: 'Safe test check' });
      assert.equal(res.success, true);
      assert.equal(res.simulated, true);
      assert.equal(res.provider, 'simulated');
      assert.equal(res.recipient, '+919876543210');
      assert.ok(res.message.startsWith('[TEST — not a real emergency]'));
      assert.ok(res.message.includes('Safe test check'));

      // Verify recorded in audit log
      const logs = store.getAlertLog();
      const testLog = logs.find((l) => l.type === 'MANUAL_TEST_ALERT');
      assert.ok(testLog);
      assert.equal(testLog.status, 'TEST');
    });
  });

  describe('smsStatusSummary()', () => {
    test('returns accurate provider configuration and stats', () => {
      store.setRecipientConsent({
        phone: '+919876543210',
        consentGiven: true,
      });

      const summary = smsStatusSummary();
      assert.equal(typeof summary.configured, 'boolean');
      assert.equal(typeof summary.isSimulated, 'boolean');
      assert.equal(summary.registeredRecipientsCount, 1);
      assert.equal(summary.lastStatus, 'SAFE');
    });
  });
});

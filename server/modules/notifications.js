/**
 * Emergency Notification & Alert Dispatcher Module
 *
 * Provides notification provider abstractions (Simulated vs Twilio),
 * stateful alert deduplication and cooldown enforcement, escalation triggers,
 * consent-guarded dispatching, and audit logging.
 */

import crypto from 'crypto';
import { config, smsIsConfigured, isRealSmsConfigured } from '../config.js';
import { store } from '../store.js';

// Status severity ranks for detecting escalations
const SEVERITY_RANK = {
  SAFE: 0,
  WARNING: 1,
  HIGH_RISK: 2,
  DANGER: 3,
  SENSOR_FAULT: 4,
};

/**
 * Simulated SMS Provider (Zero external network calls, always safe)
 */
export async function sendSimulatedSms({ to, message }) {
  const sid = `SM_SIM_${crypto.randomUUID().slice(0, 8)}`;
  console.log(`[SIMULATED SMS] To: ${to} | Message: ${message}`);

  return {
    success: true,
    sid,
    provider: 'simulated',
    to,
    message,
    sentAt: new Date().toISOString(),
  };
}

/**
 * Twilio SMS Provider (Real HTTP call via Twilio REST API)
 */
export async function sendTwilioSms({ to, message }) {
  const accountSid = config.sms?.twilioAccountSid || config.TWILIO_ACCOUNT_SID;
  const authToken = config.sms?.twilioAuthToken || config.TWILIO_AUTH_TOKEN;
  const fromPhone = config.sms?.twilioFromPhone || config.TWILIO_FROM_PHONE;

  if (!accountSid || !authToken || !fromPhone) {
    throw new Error('Twilio credentials incomplete or unconfigured');
  }

  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const basicAuth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

  const bodyParams = new URLSearchParams({
    To: to,
    From: fromPhone,
    Body: message,
  });

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: bodyParams.toString(),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Twilio API HTTP ${res.status}: ${errText || res.statusText}`);
  }

  const data = await res.json();
  return {
    success: true,
    sid: data.sid,
    provider: 'twilio',
    to,
    message,
    sentAt: new Date().toISOString(),
  };
}

/**
 * Dispatches an SMS using either Twilio or the Simulated provider.
 */
async function dispatchSms({ to, message, forceSimulated = false }) {
  const useRealTwilio =
    !forceSimulated &&
    (config.sms?.provider === 'twilio' || config.SMS_PROVIDER === 'twilio') &&
    isRealSmsConfigured();

  if (useRealTwilio) {
    try {
      return await sendTwilioSms({ to, message });
    } catch (err) {
      console.error(`[Notifications] Twilio send failed, falling back to simulated log: ${err.message}`);
      return await sendSimulatedSms({ to, message: `[FALLBACK] ${message}` });
    }
  }

  return await sendSimulatedSms({ to, message });
}

/**
 * Evaluates whether an alert should be dispatched based on status transitions
 * and cooldown rules.
 *
 * Rules:
 *  - Escalations (e.g. WARNING -> DANGER) ALWAYS fire immediately (bypass cooldown).
 *  - Identical status checks within cooldown are deduplicated and suppressed.
 *  - Recoveries to SAFE or WARNING are logged to audit trail, but NEVER send SMS.
 *  - Recovery NEVER erases prior audit history.
 *
 * @param {string} currentStatus Current status
 * @param {string} previousStatus Previous status
 * @param {number} cooldownMinutes Cooldown period
 * @returns {{ shouldSend: boolean, isEscalation: boolean, isRecovery: boolean, reason: string }}
 */
export function shouldNotify(
  currentStatus,
  previousStatus = null,
  cooldownMinutes = config.alerts?.cooldownMinutes || 15
) {
  const prev = previousStatus || store.getAlertDedup().lastStatus || 'SAFE';
  const curr = currentStatus;

  const prevRank = SEVERITY_RANK[prev] ?? 0;
  const currRank = SEVERITY_RANK[curr] ?? 0;

  // Recovery condition: current severity dropped below previous
  if (currRank < prevRank) {
    return {
      shouldSend: false,
      isEscalation: false,
      isRecovery: true,
      reason: `Recovery transition from ${prev} to ${curr}`,
    };
  }

  // Non-emergency states never send emergency SMS
  if (curr === 'SAFE') {
    return {
      shouldSend: false,
      isEscalation: false,
      isRecovery: false,
      reason: 'Status is SAFE',
    };
  }

  // Escalation: severity increased (e.g. WARNING -> HIGH_RISK or DANGER)
  if (currRank > prevRank) {
    return {
      shouldSend: true,
      isEscalation: true,
      isRecovery: false,
      reason: `Status escalated from ${prev} to ${curr}`,
    };
  }

  // Identical status: enforce cooldown
  const canSend = store.canSendAlert(curr, cooldownMinutes);
  if (!canSend) {
    return {
      shouldSend: false,
      isEscalation: false,
      isRecovery: false,
      reason: `Identical status ${curr} within ${cooldownMinutes}m cooldown window`,
    };
  }

  return {
    shouldSend: true,
    isEscalation: false,
    isRecovery: false,
    reason: `Cooldown elapsed for status ${curr}`,
  };
}

/**
 * Evaluates incoming risk assessment and dispatches alerts when required.
 * Called immediately after evaluateRisk() on sensor ingestion.
 *
 * @param {Object} riskAssessment Evaluated risk object
 * @returns {Promise<Object>} Execution report
 */
export async function evaluateAndNotify(riskAssessment) {
  if (!riskAssessment || !riskAssessment.status || riskAssessment.status === 'UNKNOWN') {
    return { notified: false, reason: 'No evaluated risk available' };
  }

  const currentStatus = riskAssessment.status;
  const dedupState = store.getAlertDedup();
  const previousStatus = dedupState.lastStatus || 'SAFE';
  const cooldownMin = config.alerts?.cooldownMinutes || config.ALERT_COOLDOWN_MINUTES || 15;

  const decision = shouldNotify(currentStatus, previousStatus, cooldownMin);

  // 1. Handle Recovery Transition (SAFE or lower severity)
  if (decision.isRecovery) {
    store.addAlertLog({
      type: 'RECOVERY',
      status: currentStatus,
      riskScore: riskAssessment.totalScore ?? 0,
      message: `Landslide risk level returned to ${currentStatus} (from ${previousStatus}). Alert history preserved.`,
      details: { previousStatus, currentStatus },
    });

    store.updateAlertDedup({
      lastStatus: currentStatus,
      lastLevel: currentStatus,
    });

    return {
      notified: false,
      status: currentStatus,
      isRecovery: true,
      message: `System transitioned to ${currentStatus}; recovery logged to audit trail`,
    };
  }

  // 2. Handle Suppressed / In-Cooldown State
  if (!decision.shouldSend) {
    store.addAlertLog({
      type: 'DEDUP_SUPPRESSED',
      status: currentStatus,
      riskScore: riskAssessment.totalScore ?? 0,
      message: `Notification suppressed: ${decision.reason}`,
      details: { currentStatus, previousStatus, reason: decision.reason },
    });

    return {
      notified: false,
      status: currentStatus,
      suppressed: true,
      reason: decision.reason,
    };
  }

  // 3. Dispatch Emergency Notification (HIGH_RISK or DANGER)
  const isEmergency = currentStatus === 'HIGH_RISK' || currentStatus === 'DANGER';
  if (!isEmergency) {
    store.updateAlertDedup({ lastStatus: currentStatus });
    return {
      notified: false,
      status: currentStatus,
      reason: `Status ${currentStatus} does not meet emergency broadcast threshold`,
    };
  }

  // Retrieve recipients who gave consent
  const consentingRecipients = store
    .getRecipients()
    .filter((r) => r.phone && r.consentGiven);

  const siteLabel = config.site?.label || config.SITE_LABEL || 'Landslide Monitoring Station';
  const shelterLabel = config.SAFE_DEST_LABEL || 'Designated Evacuation Shelter';
  const score = riskAssessment.totalScore ?? 0;

  let alertMessage;
  if (currentStatus === 'DANGER') {
    alertMessage = `🚨 CRITICAL LANDSLIDE DANGER at ${siteLabel}! Risk Score: ${score}/10+. Immediate slope failure danger detected. Evacuate to ${shelterLabel} immediately!`;
  } else {
    alertMessage = `⚠️ LANDSLIDE HIGH RISK ALERT at ${siteLabel}! Risk Score: ${score}/10. Significant slope instability detected. Prepare for immediate evacuation to ${shelterLabel}.`;
  }

  if (consentingRecipients.length === 0) {
    store.recordAlertSent(currentStatus);

    store.addAlertLog({
      type: decision.isEscalation ? 'ESCALATION_ALERT' : 'EMERGENCY_ALERT',
      status: currentStatus,
      riskScore: score,
      message: `${alertMessage} [SMS skipped: no consenting recipient registered]`,
      recipients: [],
      details: {
        isEscalation: decision.isEscalation,
        recipientCount: 0,
        smsSkipped: true,
        reason: 'No consenting recipients registered',
      },
    });

    return {
      notified: false,
      status: currentStatus,
      isEscalation: decision.isEscalation,
      recipientsNotified: 0,
      deliveries: [],
      skipped: true,
      reason: 'No consenting recipients registered; emergency SMS skipped without fabricating success',
    };
  }

  const results = [];
  for (const recipient of consentingRecipients) {
    try {
      const res = await dispatchSms({ to: recipient.phone, message: alertMessage });
      results.push(res);
    } catch (err) {
      results.push({ to: recipient.phone, success: false, error: err.message });
    }
  }

  // Record sent state to update cooldown
  store.recordAlertSent(currentStatus);

  // Permanently append to alert audit log
  store.addAlertLog({
    type: decision.isEscalation ? 'ESCALATION_ALERT' : 'EMERGENCY_ALERT',
    status: currentStatus,
    riskScore: score,
    message: alertMessage,
    recipients: results,
    details: {
      isEscalation: decision.isEscalation,
      recipientCount: consentingRecipients.length,
      siteLabel,
      shelterLabel,
    },
  });

  return {
    notified: true,
    status: currentStatus,
    isEscalation: decision.isEscalation,
    recipientsNotified: results.length,
    deliveries: results,
  };
}

/**
 * Sends a manual test alert.
 * ALWAYS uses the simulated provider and a message prefixed with "[TEST — not a real emergency]"
 * unless config.sms.allowRealTestSms === true; NEVER uses the real emergency template.
 * Refuses without a consenting recipient.
 *
 * @param {Object} [params]
 * @param {string} [params.phone] Optional recipient phone
 * @param {boolean} [params.consent] Affirmative consent if testing new number
 * @param {string} [params.customNote] Optional test note
 * @returns {Promise<Object>} Test result or refusal
 */
export async function sendTestAlert(params = {}) {
  const allowReal =
    config.sms?.allowRealTestSms === true || config.ALLOW_REAL_TEST_SMS === true;

  // Retrieve test recipient
  let recipientPhone = params.phone;
  let hasConsent = false;

  if (recipientPhone) {
    const active = store.getRecipients().find((r) => r.phone === recipientPhone && r.consentGiven);
    if (
      active ||
      params.consent === true ||
      (store.getRecipientConsent()?.phone === recipientPhone && store.getRecipientConsent()?.consentGiven)
    ) {
      hasConsent = true;
    }
  } else {
    const active = store.getRecipients().find((r) => r.phone && r.consentGiven);
    if (active) {
      recipientPhone = active.phone;
      hasConsent = true;
    } else {
      const stored = store.getRecipientConsent();
      if (stored && stored.phone && stored.consentGiven) {
        recipientPhone = stored.phone;
        hasConsent = true;
      }
    }
  }

  // Refuse if no verified consenting recipient
  if (!recipientPhone || !hasConsent) {
    return {
      success: false,
      refused: true,
      error: 'No consenting recipient registered for test alert',
      message: 'Test alert refused: affirmative user consent is required before dispatching alerts',
      simulated: true,
    };
  }

  const siteLabel = config.site?.label || config.SITE_LABEL || 'IIT Bombay Hillside';
  const testMessage = `[TEST — not a real emergency] Landslide early-warning telemetry test from ${siteLabel}. System nominal at ${new Date().toLocaleTimeString()}. ${params.customNote || ''}`.trim();

  // If allowRealTestSms is false (default), force simulated provider
  const forceSimulated = !allowReal;
  const dispatchRes = await dispatchSms({
    to: recipientPhone,
    message: testMessage,
    forceSimulated,
  });

  // Log test alert to audit log
  store.addAlertLog({
    type: 'MANUAL_TEST_ALERT',
    status: 'TEST',
    riskScore: 0,
    message: testMessage,
    recipients: [dispatchRes],
    details: {
      allowRealTestSms: allowReal,
      providerUsed: dispatchRes.provider,
      recipient: recipientPhone,
    },
  });

  return {
    success: true,
    simulated: dispatchRes.provider === 'simulated',
    provider: dispatchRes.provider,
    recipient: recipientPhone,
    message: testMessage,
    allowRealTestSms: allowReal,
    details: dispatchRes,
  };
}

/**
 * Returns summary of SMS provider configuration and delivery state for the UI.
 *
 * @returns {Object}
 */
export function smsStatusSummary() {
  const allowReal =
    config.sms?.allowRealTestSms === true || config.ALLOW_REAL_TEST_SMS === true;
  const configured = smsIsConfigured();
  const realSms = isRealSmsConfigured();

  const consentingCount = store
    .getRecipients()
    .filter((r) => r.phone && r.consentGiven).length;

  return {
    configured,
    realSmsReady: realSms,
    provider: config.sms?.provider || config.SMS_PROVIDER || 'console',
    isSimulated: !realSms,
    allowRealTestSms: allowReal,
    registeredRecipientsCount: consentingCount,
    lastAlertSentAt: store.getAlertDedup().lastAlertSentAt,
    lastStatus: store.getAlertDedup().lastStatus,
    cooldownMinutes: config.alerts?.cooldownMinutes || config.ALERT_COOLDOWN_MINUTES || 15,
  };
}

export default {
  shouldNotify,
  evaluateAndNotify,
  sendTestAlert,
  smsStatusSummary,
  sendSimulatedSms,
  sendTwilioSms,
};

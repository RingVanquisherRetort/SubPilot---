import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "@subpilot/database";
import { createPlatformPaymentCheckout, PlatformPaymentLifecycleError } from "./platform-payment-lifecycle.js";
import {
  createPlatformWebSession,
  isExpectedWebOrigin,
  verifyPlatformWebSession,
  verifyTelegramLoginPayload
} from "./platform-web-auth.js";

const SESSION_COOKIE = "subpilot_web_session";
const SESSION_TTL_SECONDS = 8 * 60 * 60;

interface BillingWebConfig {
  enabled: boolean;
  botToken: string;
  botUsername: string;
  origin: string;
  sessionSecret: string;
  providerConnectionId: string;
  disabledReason: string;
}

function readBillingWebConfig(): BillingWebConfig {
  const botToken = process.env.CONTROL_BOT_TOKEN ?? "";
  const botUsername = (process.env.TELEGRAM_LOGIN_BOT_USERNAME ?? "").replace(/^@/, "");
  const origin = process.env.PLATFORM_BILLING_WEB_ORIGIN ?? "";
  const sessionSecret = process.env.PLATFORM_BILLING_WEB_SESSION_SECRET ?? "";
  const providerConnectionId = process.env.PLATFORM_BILLING_PROVIDER_CONNECTION_ID ?? "";
  const returnUrl = process.env.PLATFORM_BILLING_RETURN_URL ?? "";
  let returnOriginMatches = false;
  try {
    returnOriginMatches = new URL(returnUrl).origin === origin &&
      new URL(returnUrl).protocol === "https:";
  } catch { /* invalid return URL remains disabled */ }
  const originValid = (() => {
    try {
      const parsed = new URL(origin);
      return parsed.protocol === "https:" && parsed.origin === origin;
    } catch { return false; }
  })();
  const identityConfigured = /^\d{5,20}:[A-Za-z0-9_-]{20,}$/.test(botToken) &&
    /^[A-Za-z0-9_]{5,32}$/.test(botUsername);
  const securityConfigured = Buffer.byteLength(sessionSecret, "utf8") >= 32 &&
    /^[A-Za-z0-9_-]{10,40}$/.test(providerConnectionId);
  const explicitlyReviewed = process.env.PLATFORM_BILLING_WEB_ENABLED === "true" &&
    process.env.PLATFORM_BILLING_WEB_COMPLIANCE_REVIEWED === "true" &&
    process.env.PLATFORM_BILLING_TELEGRAM_TPA_RELATED === "false";
  const enabled = identityConfigured && securityConfigured && originValid &&
    returnOriginMatches && explicitlyReviewed;
  const disabledReason = !explicitlyReviewed
    ? "Web checkout is disabled until the independent sales surface has an explicit compliance approval."
    : !identityConfigured || !securityConfigured || !originValid || !returnOriginMatches
      ? "Web checkout configuration is incomplete."
      : "";
  return {
    enabled, botToken, botUsername, origin, sessionSecret,
    providerConnectionId, disabledReason
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char] ?? char);
}

function setNoStoreHeaders(reply: FastifyReply): void {
  reply.header("Cache-Control", "no-store, private");
  reply.header("Pragma", "no-cache");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("X-Frame-Options", "DENY");
}

function readCookie(request: FastifyRequest, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return undefined;
}

function sessionTelegramId(request: FastifyRequest, config: BillingWebConfig): string | null {
  return verifyPlatformWebSession(
    readCookie(request, SESSION_COOKIE),
    config.sessionSecret
  );
}

function requireExpectedOrigin(request: FastifyRequest, config: BillingWebConfig): boolean {
  return isExpectedWebOrigin(request.headers.origin, config.origin);
}

function billingPage(config: BillingWebConfig): { html: string; csp: string } {
  const nonce = randomBytes(18).toString("base64");
  const widget = config.enabled
    ? `<div class="login"><script async src="https://telegram.org/js/telegram-widget.js?22" data-telegram-login="${escapeHtml(config.botUsername)}" data-size="large" data-onauth="onTelegramAuth(user)"></script></div>`
    : `<p class="notice">${escapeHtml(config.disabledReason)}</p>`;
  const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SubPilot — тариф рабочего пространства</title>
<style>
:root{color-scheme:dark;font-family:Inter,system-ui,-apple-system,sans-serif;background:#101114;color:#f5f6f8}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;box-sizing:border-box}
main{width:min(100%,620px);background:#1a1c21;border:1px solid #30333b;border-radius:20px;padding:28px;box-sizing:border-box}
h1{font-size:26px;margin:0 0 10px}p{color:#b8bdc7;line-height:1.55}
label{display:block;margin:16px 0 7px;color:#d7dae1}
select,button{width:100%;min-height:46px;border-radius:10px;border:1px solid #444956;background:#101216;color:#fff;padding:10px 12px;font-size:16px}
button{margin-top:18px;background:#445be9;border:0;font-weight:650;cursor:pointer}
button:disabled{opacity:.55;cursor:not-allowed}
.login{margin:24px 0}.notice{background:#2b2118;border:1px solid #61442e;border-radius:12px;padding:14px;color:#ffd0a6}
.status{margin-top:18px;padding:14px;border:1px solid #3b404a;border-radius:12px;white-space:pre-wrap}
.hidden{display:none}.muted{font-size:13px;color:#89909d}
</style>
</head>
<body>
<main>
<h1>SubPilot</h1>
<p>Управление подпиской рабочего пространства. Войдите через Telegram, чтобы увидеть доступные тарифы.</p>
<section id="login-section">${widget}</section>
<section id="billing-section" class="hidden">
<label for="workspace">Рабочее пространство</label><select id="workspace"></select>
<label for="plan">Тариф</label><select id="plan"></select>
<button id="checkout" type="button">Перейти к защищённой оплате</button>
<div id="status" class="status hidden" role="status" aria-live="polite"></div>
<button id="refresh" type="button" class="hidden">Обновить статус платежа</button>
</section>
<p class="muted">Платёж обрабатывает подключённый платёжный провайдер. Возврат на сайт сам по себе не подтверждает оплату — статус обновляется после проверки уведомления провайдера.</p>
</main>
<script nonce="${nonce}">
const loginSection=document.getElementById("login-section");
const billingSection=document.getElementById("billing-section");
const statusBox=document.getElementById("status");
const refreshButton=document.getElementById("refresh");
function showStatus(message){statusBox.textContent=message;statusBox.classList.remove("hidden");}
async function jsonRequest(url,options={}){
 const response=await fetch(url,{credentials:"same-origin",...options});
 const data=await response.json().catch(()=>({}));
 if(!response.ok)throw new Error(data.error||"Запрос не выполнен");
 return data;
}
async function loadBilling(){
 const data=await jsonRequest("/web/billing/options");
 loginSection.classList.add("hidden");
 billingSection.classList.remove("hidden");
 const workspace=document.getElementById("workspace");
 const plan=document.getElementById("plan");
 workspace.replaceChildren();
 plan.replaceChildren();
 for(const item of data.workspaces){
  const option=document.createElement("option");option.value=item.id;option.textContent=item.name;workspace.append(option);
 }
 for(const item of data.plans){
  const option=document.createElement("option");option.value=item.code;
  option.textContent=item.title+" — "+item.price+" "+item.currency+" / "+item.billingPeriodDays+" дней";plan.append(option);
 }
 const checkout=document.getElementById("checkout");
 checkout.disabled=!data.checkoutAvailable||!data.workspaces.length||!data.plans.length;
 if(!data.checkoutAvailable)showStatus("Оплата пока не настроена для этого рабочего пространства.");
 const paymentId=new URLSearchParams(location.search).get("payment_id");
 if(paymentId)await refreshPayment(paymentId);
}
async function onTelegramAuth(user){
 try{
  await jsonRequest("/web/billing/auth/telegram",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(user)});
  await loadBilling();
 }catch(error){showStatus(error.message||"Не удалось подтвердить вход через Telegram.");}
}
window.onTelegramAuth=onTelegramAuth;
async function refreshPayment(paymentId){
 try{
  const data=await jsonRequest("/web/billing/status?payment_id="+encodeURIComponent(paymentId));
  const labels={CREATED:"создан",PENDING:"ожидает подтверждения провайдера",SUCCEEDED:"оплачен",REFUNDING:"возврат обрабатывается",REFUNDED:"возвращён",FAILED:"ошибка оплаты",CANCELLED:"отменён"};
  showStatus("Платёж "+data.paymentId+": "+(labels[data.status]||data.status)+
   (data.currentPeriodEnd?"\nДоступ оплачен до: "+new Date(data.currentPeriodEnd).toLocaleDateString("ru-RU"):""));
 }catch(error){showStatus(error.message||"Не удалось получить статус платежа.");}
 refreshButton.classList.remove("hidden");
 refreshButton.onclick=()=>refreshPayment(paymentId);
}
document.getElementById("checkout").addEventListener("click",async()=>{
 const button=document.getElementById("checkout");button.disabled=true;
 try{
  const result=await jsonRequest("/web/billing/checkout",{method:"POST",headers:{"content-type":"application/json"},
   body:JSON.stringify({workspaceId:document.getElementById("workspace").value,
    planCode:document.getElementById("plan").value,idempotencyKey:crypto.randomUUID()})});
  if(result.checkoutUrl){location.assign(result.checkoutUrl);return;}
  showStatus(result.status==="SUCCEEDED"?"Подписка уже активирована.":"Платёж создан.");
 }catch(error){showStatus(error.message||"Не удалось создать платёж.");}
 finally{button.disabled=false;}
});
loadBilling().catch(()=>{});
</script>
</body>
</html>`;
  const csp = [
    "default-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    `script-src 'self' 'nonce-${nonce}' https://telegram.org`,
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self'",
    "frame-src https://oauth.telegram.org https://telegram.org",
    "img-src 'self' data: https://telegram.org https://t.me"
  ].join("; ");
  return { html, csp };
}

export function registerPlatformBillingWebRoutes(app: FastifyInstance): void {
  app.get("/billing", async (_request, reply) => {
    const config = readBillingWebConfig();
    const page = billingPage(config);
    setNoStoreHeaders(reply);
    reply.header("Content-Security-Policy", page.csp);
    return reply.type("text/html; charset=utf-8").send(page.html);
  });

  app.get("/billing/return", async (_request, reply) => {
    const config = readBillingWebConfig();
    const page = billingPage(config);
    setNoStoreHeaders(reply);
    reply.header("Content-Security-Policy", page.csp);
    return reply.type("text/html; charset=utf-8").send(page.html);
  });

  app.post<{ Body: unknown }>("/web/billing/auth/telegram", async (request, reply) => {
    const config = readBillingWebConfig();
    setNoStoreHeaders(reply);
    if (!config.enabled) return reply.code(503).send({ error: "Веб-оплата пока не включена." });
    if (!requireExpectedOrigin(request, config)) return reply.code(403).send({ error: "Недопустимый источник запроса." });
    if (typeof request.headers["content-type"] !== "string" || !/^application\\/json(?:;|$)/i.test(request.headers["content-type"])) return reply.code(415).send({ error: "Требуется application/json." });
    try {
      const identity = verifyTelegramLoginPayload(request.body, config.botToken);
      const session = createPlatformWebSession(identity.telegramId, config.sessionSecret);
      reply.header("Set-Cookie",
        `${SESSION_COOKIE}=${session}; Max-Age=${SESSION_TTL_SECONDS}; Path=/web/billing; HttpOnly; Secure; SameSite=Lax`);
      return reply.send({ ok: true, firstName: identity.firstName });
    } catch {
      return reply.code(401).send({ error: "Данные входа Telegram недействительны или устарели." });
    }
  });

  app.get("/web/billing/options", async (request, reply) => {
    const config = readBillingWebConfig();
    setNoStoreHeaders(reply);
    if (!config.enabled) return reply.code(503).send({ error: "Веб-оплата пока не включена." });
    const telegramId = sessionTelegramId(request, config);
    if (!telegramId) return reply.code(401).send({ error: "Требуется повторный вход через Telegram." });

    const memberships = await prisma.workspaceMember.findMany({
      where: {
        role: { in: ["OWNER", "ADMIN"] },
        user: { telegramId: BigInt(telegramId) }
      },
      select: { workspace: { select: { id: true, name: true } } },
      orderBy: { createdAt: "asc" }
    });
    const seen = new Set<string>();
    const workspaces = memberships
      .map((item) => item.workspace)
      .filter((workspace) => !seen.has(workspace.id) && Boolean(seen.add(workspace.id)));
    const [plans, connection] = await Promise.all([
      prisma.platformPlan.findMany({
        where: { isActive: true, price: { gt: 0 } },
        select: { code: true, title: true, price: true, currency: true, billingPeriodDays: true },
        orderBy: [{ price: "asc" }, { title: "asc" }]
      }),
      prisma.platformPaymentProviderConnection.findFirst({
        where: {
          id: config.providerConnectionId,
          provider: "YOOKASSA",
          status: "ACTIVE"
        },
        select: { id: true }
      })
    ]);
    return reply.send({
      workspaces,
      plans: plans.map((plan) => ({
        ...plan,
        price: plan.price.toString()
      })),
      checkoutAvailable: Boolean(connection && plans.length)
    });
  });

  app.post<{ Body: unknown }>("/web/billing/checkout", async (request, reply) => {
    const config = readBillingWebConfig();
    setNoStoreHeaders(reply);
    if (!config.enabled) return reply.code(503).send({ error: "Веб-оплата пока не включена." });
    if (!requireExpectedOrigin(request, config)) return reply.code(403).send({ error: "Недопустимый источник запроса." });
    if (typeof request.headers["content-type"] !== "string" || request.headers["content-type"].split(";")[0]?.trim().toLowerCase() !== "application/json") return reply.code(415).send({ error: "Требуется application/json." });
    const telegramId = sessionTelegramId(request, config);
    if (!telegramId) return reply.code(401).send({ error: "Требуется повторный вход через Telegram." });
    if (typeof request.body !== "object" || request.body === null || Array.isArray(request.body)) {
      return reply.code(400).send({ error: "Некорректные параметры оформления." });
    }
    const body = request.body as Record<string, unknown>;
    const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "";
    const planCode = typeof body.planCode === "string" ? body.planCode : "";
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    if (!/^[A-Za-z0-9_-]{10,40}$/.test(workspaceId) ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/.test(planCode) ||
        !/^[0-9a-f-]{36}$/i.test(idempotencyKey)) {
      return reply.code(400).send({ error: "Некорректные параметры оформления." });
    }
    const connection = await prisma.platformPaymentProviderConnection.findFirst({
      where: {
        id: config.providerConnectionId,
        provider: "YOOKASSA",
        status: "ACTIVE"
      },
      select: { id: true }
    });
    if (!connection) return reply.code(503).send({ error: "Платёжный провайдер временно недоступен." });
    try {
      const result = await createPlatformPaymentCheckout({
        workspaceId,
        planCode,
        providerConnectionId: connection.id,
        actorTelegramId: telegramId,
        idempotencyKey,
        salesSurface: "INDEPENDENT_WEB",
        telegramTpaRelated: false
      });
      return reply.send(result);
    } catch (error) {
      if (error instanceof PlatformPaymentLifecycleError) {
        const messages: Record<string, string> = {
          CHECKOUT_NOT_ELIGIBLE: "Этот сценарий оплаты не разрешён политикой платформы.",
          INVALID_ACTOR: "Не удалось подтвердить пользователя.",
          WORKSPACE_ACCESS_DENIED: "У пользователя нет прав владельца или администратора этого пространства.",
          PLAN_NOT_AVAILABLE: "Выбранный тариф недоступен.",
          PROVIDER_NOT_AVAILABLE: "Платёжный провайдер не активен.",
          RETURN_URL_NOT_CONFIGURED: "Не настроен адрес возврата после оплаты.",
          IDEMPOTENCY_CONFLICT: "Ключ запроса уже использован для другого платежа.",
          PAYMENT_ALREADY_FINAL: "Этот платёж уже завершён.",
          PLAN_CHANGE_REQUIRES_MANUAL_REVIEW: "Смена тарифа в оплаченный период требует ручной сверки.",
          PROVIDER_CONNECTION_NOT_FOUND: "Подключение провайдера не найдено.",
          INVALID_PROVIDER_CREDENTIALS: "Реквизиты провайдера недействительны."
        };
        return reply.code(400).send({ error: messages[error.code] ?? "Не удалось создать платёж." });
      }
      request.log.error({ errorName: error instanceof Error ? error.name : "UnknownError" },
        "Independent web checkout creation failed");
      return reply.code(503).send({ error: "Не удалось создать платёж. Попробуйте позже." });
    }
  });

  app.get<{ Querystring: { payment_id?: string } }>("/web/billing/status", async (request, reply) => {
    const config = readBillingWebConfig();
    setNoStoreHeaders(reply);
    if (!config.enabled) return reply.code(503).send({ error: "Веб-оплата пока не включена." });
    const telegramId = sessionTelegramId(request, config);
    if (!telegramId) return reply.code(401).send({ error: "Требуется повторный вход через Telegram." });
    const paymentId = request.query.payment_id ?? "";
    if (!/^[A-Za-z0-9_-]{10,40}$/.test(paymentId)) {
      return reply.code(400).send({ error: "Некорректный идентификатор платежа." });
    }
    const payment = await prisma.platformPayment.findUnique({
      where: { id: paymentId },
      select: {
        id: true, workspaceId: true, status: true,
        paidAt: true, refundedAt: true, amount: true, currency: true
      }
    });
    if (!payment) return reply.code(404).send({ error: "Платёж не найден." });
    const membership = await prisma.workspaceMember.findFirst({
      where: {
        workspaceId: payment.workspaceId,
        role: { in: ["OWNER", "ADMIN"] },
        user: { telegramId: BigInt(telegramId) }
      },
      select: { id: true }
    });
    if (!membership) return reply.code(403).send({ error: "Нет доступа к этому платежу." });
    const billing = await prisma.workspaceBilling.findUnique({
      where: { workspaceId: payment.workspaceId },
      select: { currentPeriodEnd: true }
    });
    return reply.send({
      paymentId: payment.id,
      status: payment.status,
      amount: payment.amount.toString(),
      currency: payment.currency,
      paidAt: payment.paidAt,
      refundedAt: payment.refundedAt,
      currentPeriodEnd: billing?.currentPeriodEnd ?? null
    });
  });
}

import {
  parseWorkspacePlanFeatureConfig,
  type WorkspacePlanFeatureConfig
} from "./workspace-plan-limits.js";

export interface PlatformPlanUpsertInput {
  code: string;
  title: string;
  description: string | null;
  price: string;
  currency: string;
  billingPeriodDays: number;
  features: WorkspacePlanFeatureConfig;
}

function parseQuota(value: string, fieldName: string): number | null {
  if (value === "*") return null;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`Лимит «${fieldName}» должен быть целым числом от 0 или * для безлимитного значения.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Лимит «${fieldName}» выходит за допустимый диапазон.`);
  }
  return parsed;
}

/**
 * Parses:
 * CODE | TITLE | PRICE | CURRENCY | PERIOD_DAYS | PROJECTS | MEMBERS |
 * PLANS_PER_PROJECT | CHATS_PER_PROJECT | DESCRIPTION
 *
 * An asterisk is the only way to request an unlimited quota. Zero means disabled.
 */
export function parsePlatformPlanUpsertInput(raw: string): PlatformPlanUpsertInput {
  const fields = raw.split("|").map((field) => field.trim());
  if (fields.length !== 10) {
    throw new Error(
      "Формат: /platformplan CODE | Название | Цена | Валюта | Дней | Проекты | Участники | Тарифы/проект | Площадки/проект | Описание\n" +
      "Для безлимитного лимита укажите *, для отключённого ресурса — 0."
    );
  }

  const [code, title, rawPrice, rawCurrency, rawPeriod, rawProjects,
    rawMembers, rawPlans, rawChats, rawDescription] = fields;

  if (!code || !/^[a-z][a-z0-9_-]{1,39}$/.test(code)) {
    throw new Error("Код тарифа: от 2 до 40 символов, строчные латинские буквы, цифры, дефис или подчёркивание; начинаться с буквы.");
  }
  if (!title || title.length < 2 || title.length > 80) {
    throw new Error("Название тарифа должно содержать от 2 до 80 символов.");
  }
  if (!rawPrice || !/^(0|[1-9][0-9]{0,9})(\.[0-9]{1,2})?$/.test(rawPrice)) {
    throw new Error("Цена должна быть неотрицательным десятичным числом с точностью до 2 знаков, без разделителей тысяч.");
  }
  if (!rawCurrency || !/^[A-Z]{3}$/.test(rawCurrency)) {
    throw new Error("Валюта должна быть указана трёхбуквенным кодом в верхнем регистре, например RUB.");
  }
  if (!rawPeriod || !/^[1-9][0-9]{0,3}$/.test(rawPeriod)) {
    throw new Error("Период оплаты должен быть целым числом от 1 до 3650 дней.");
  }
  const billingPeriodDays = Number(rawPeriod);
  if (!Number.isSafeInteger(billingPeriodDays) || billingPeriodDays > 3650) {
    throw new Error("Период оплаты должен быть целым числом от 1 до 3650 дней.");
  }
  if (rawDescription && rawDescription.length > 300) {
    throw new Error("Описание тарифа не должно превышать 300 символов.");
  }

  const features = parseWorkspacePlanFeatureConfig({
    schemaVersion: 1,
    limits: {
      projects: parseQuota(rawProjects ?? "", "проекты"),
      members: parseQuota(rawMembers ?? "", "участники"),
      plansPerProject: parseQuota(rawPlans ?? "", "тарифы на проект"),
      connectedChatsPerProject: parseQuota(rawChats ?? "", "площадки на проект")
    }
  });

  return {
    code,
    title,
    description: rawDescription || null,
    price: rawPrice,
    currency: rawCurrency,
    billingPeriodDays,
    features
  };
}

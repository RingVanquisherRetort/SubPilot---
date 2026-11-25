export type Locale = "ru" | "en";

export function resolveLocale(languageCode?: string | null): Locale {
  const primary = languageCode?.trim().toLowerCase().split(/[-_]/)[0];
  return primary === "en" ? "en" : "ru";
}

const ru = {
  start: "Открыть главное меню SubPilot",
  help: "Помощь по интерфейсу",
  testnotifications: "Отправить тестовые уведомления себе",
  projects: "Список доступных проектов",
  agencyportfolio: "Портфель проектов агентства",
  projectmembers: "Доступ к участникам проекта",
  setprojectmember: "Назначить роль в проекте",
  removeprojectmember: "Снять доступ к проекту",
  assigncreator: "Назначить автора проекта",
  unassigncreator: "Снять автора проекта"
} as const;

type MessageKey = keyof typeof ru;
const en: Record<MessageKey, string> = {
  start: "Open the SubPilot main menu",
  help: "Interface help",
  testnotifications: "Send yourself test notifications",
  projects: "List available projects",
  agencyportfolio: "Agency project portfolio",
  projectmembers: "Manage project members",
  setprojectmember: "Assign a project role",
  removeprojectmember: "Remove project access",
  assigncreator: "Assign a project creator",
  unassigncreator: "Unassign a project creator"
};

export function translate(locale: Locale, key: MessageKey): string {
  return (locale === "en" ? en : ru)[key];
}

export function localizedCommands(locale: Locale) {
  return (Object.keys(ru) as MessageKey[]).map(command => ({
    command,
    description: translate(locale, command)
  }));
}

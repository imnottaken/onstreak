import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine, MemoryStore, localize, resolveConfig } from "../dist/index.js";
import { config as base } from "./fixtures.mjs";

const start = Date.parse("2026-11-16T06:00:00Z");
const config = {
  ...base,
  achievements: [
    {
      id: "bookworm",
      name: "Bookworm",
      description: "Finish lessons",
      when: { metric: "lesson_completed" },
      translations: { es: { name: "Ratón de biblioteca", description: "Termina lecciones" }, "pt-BR": { name: "Rato de biblioteca" } },
      tiers: [
        { name: "Bronze", gte: 1, translations: { es: { name: "Bronce" } } },
        { name: "Silver", gte: 5, translations: { es: { name: "Plata" } } },
      ],
    },
  ],
  quests: [{ id: "two", name: "Two lessons", period: "daily", goal: { event: "lesson_completed", target: 2 }, translations: { es: { name: "Dos lecciones" } } }],
  items: [{ id: "sticker", name: "Sticker", description: "A sticker", price: { currency: "coins", amount: 1 }, translations: { es: { name: "Pegatina" } } }],
  calendars: [{ id: "login", name: "Daily login", event: "app_opened", days: [{ rewards: [] }], translations: { ES: { name: "Entrada diaria" } } }],
};

test("localize falls back from region to language to default", () => {
  const e = { name: "Bookworm", description: "Read", translations: { pt: { name: "Rato" }, "pt-BR": { description: "Leia" } } };
  assert.deepEqual(localize(e, "pt-BR"), { name: "Bookworm", description: "Leia" }, "a field missing in the exact match falls back to the default, not the language");
  assert.deepEqual(localize(e, "pt-PT"), { name: "Rato", description: "Read" });
  assert.deepEqual(localize(e, "PT"), { name: "Rato", description: "Read" }, "case does not matter");
  assert.deepEqual(localize(e, "fr"), { name: "Bookworm", description: "Read" });
  assert.deepEqual(localize(e, undefined), { name: "Bookworm", description: "Read" });
});

test("names come back in the asked-for locale", async () => {
  const engine = new Engine(config, new MemoryStore(), () => start);
  await engine.track({ userId: "a", event: "lesson_completed" });

  const user = await engine.getUser("a", { locale: "es-MX" });
  assert.deepEqual(user.achievements.map((x) => [x.name, x.description, x.tier.name]), [["Ratón de biblioteca", "Termina lecciones", "Bronce"]]);
  const list = await engine.achievements("a", { locale: "es" });
  assert.deepEqual([list.achievements[0].name, list.achievements[0].tiers.map((t) => t.name)], ["Ratón de biblioteca", ["Bronce", "Plata"]]);
  assert.equal((await engine.achievements("a", { locale: "pt-BR" })).achievements[0].description, "Finish lessons");
  assert.equal((await engine.quests("a", { locale: "es" })).quests[0].name, "Dos lecciones");
  const shop = await engine.rewardStore("a", { locale: "es" });
  assert.deepEqual([shop.items[0].name, shop.items[0].description], ["Pegatina", "A sticker"]);
  assert.equal((await engine.calendars("a", { locale: "es" })).calendars[0].name, "Entrada diaria");
  assert.equal((await engine.getUser("a")).achievements[0].name, "Bookworm");

  for (const locale of ["english", "e", "es_ES", ""]) {
    await assert.rejects(engine.quests("a", { locale }), (e) => e.status === 400);
  }
});

test("translations are validated", () => {
  const bad = (translations, re) => assert.throws(() => resolveConfig({ ...config, items: [{ ...config.items[0], translations }] }), re);
  bad([], /object of locales/);
  bad({ "es_ES": { name: "x" } }, /bad locale/);
  bad({ es: "Pegatina" }, /name\?, description\?/);
  bad({ es: { title: "x" } }, /only have name and description/);
  bad({ es: { name: "" } }, /1-500 characters/);
  assert.throws(() => resolveConfig({ ...config, achievements: [{ ...config.achievements[0], tiers: [{ name: "B", gte: 1, translations: { es: { name: 5 } } }, { name: "S", gte: 2 }] }] }), /achievement "bookworm"/);
});

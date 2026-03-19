function collapseWhitespace(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function normalizeUnicode(text) {
  return String(text ?? "")
    .replace(/\u00A0/g, " ")
    .replace(/\u200B/g, "")
    .replace(/\u2013/g, "-")
    .replace(/\u2014/g, "-")
    .replace(/\u2212/g, "-");
}

function normalizeForMatch(text) {
  const s = normalizeUnicode(text).toLowerCase();
  // Keep letters/digits/spaces and a small set of punctuation for phrases.
  return s.replace(/[^a-z0-9\s\-\(\)\,\.]/g, " ").replace(/\s+/g, " ").trim();
}

const taxonomy = {
  unknown: { code: "unknown", name: "Unknown" },

  // Start small and bias toward transparency. This can be expanded later.
  aircraft_electrical: {
    code: "aircraft_electrical",
    name: "Aircraft Systems - Electrical",
    topics: {
      electrical_theory: {
        code: "electrical_theory",
        name: "Electrical theory",
        keywords: [
          "ohm",
          "ohm's law",
          "resistance",
          "volt",
          "voltage",
          "current",
          "ampere",
          "ampere",
          "power",
          "watt",
          "impedance",
        ],
      },
      motors_generators: {
        code: "motors_generators",
        name: "Motors & generators",
        keywords: [
          "dc motor",
          "ac motor",
          "induction motor",
          "shunt wound",
          "series wound",
          "compound wound",
          "commutator",
          "rectifier",
          "inverter",
          "alternator",
          "generator",
          "dme",
        ],
      },
      distribution_protection: {
        code: "distribution_protection",
        name: "Distribution & protection",
        keywords: [
          "busbar",
          "bus bar",
          "load shedding",
          "static discharger",
          "discharger",
          "short circuit",
          "circuit breaker",
          "short-circuit",
          "maintenance bus",
          "energised",
          "energized",
        ],
      },
    },
  },

  meteorology: {
    code: "meteorology",
    name: "Meteorology",
    topics: {
      weather_phenomena: {
        code: "weather_phenomena",
        name: "Weather phenomena",
        keywords: ["turbulence", "icing", "cloud", "visibility", "fog", "mist", "precipitation"],
      },
      pressure_wind: {
        code: "pressure_wind",
        name: "Pressure & wind",
        keywords: ["pressure", "temperature", "wind", "jet stream", "wind shear", "thunderstorm"],
      },
    },
  },

  navigation_radio: {
    code: "navigation_radio",
    name: "Navigation & Radio Navigation",
    topics: {
      vor_ndb: {
        code: "vor_ndb",
        name: "VOR/NDB",
        keywords: ["vor", "ndb", "adf", "dme", "vor/dme", "bearing", "radial"],
      },
      gps_fms: {
        code: "gps_fms",
        name: "GPS/FMS",
        keywords: ["gps", "fms", "waypoint", "track", "magnetic variation", "true north"],
      },
    },
  },

  air_law: {
    code: "air_law",
    name: "Air Law",
    topics: {
      regulations: {
        code: "regulations",
        name: "Regulations",
        keywords: ["easa", "regulation", "licence", "certificate", "authority", "authority", "enforcement"],
      },
      atm_ats: {
        code: "atm_ats",
        name: "ATM/ATS & procedures",
        keywords: ["ats", "air traffic", "airspace", "notam", "icao", "safety management"],
      },
    },
  },
};

function keywordHits(text, keywords) {
  const hits = [];
  for (const kw of keywords) {
    const k = kw.toLowerCase();
    if (k.length === 0) continue;
    if (text.includes(k)) hits.push(kw);
  }
  return hits;
}

export function classifyQuestion({
  externalId,
  questionText,
  options,
} = {}) {
  const combinedRaw = [externalId, questionText, options?.A, options?.B, options?.C, options?.D].join("\n");
  const text = normalizeForMatch(combinedRaw);

  // Deterministic ID hint (best-effort, low precision).
  // Example ids look like: "021.09 Part 5 Q0012 :"
  const partMatch = String(externalId ?? "").match(/part\s+(\d+)/i);
  const partNum = partMatch ? Number(partMatch[1]) : null;

  let best = {
    subject_code: "unknown",
    subject_name: taxonomy.unknown.name,
    topic_code: "unknown",
    topic_name: "Unknown",
    confidence: 0.2,
    evidence: { subjectKeywords: [], topicKeywords: [], idPartHint: partNum },
  };

  // Score subjects
  for (const [subjectKey, subject] of Object.entries(taxonomy)) {
    if (subjectKey === "unknown") continue;

    const subjectKeywords = [];
    // We don't have subject-level keyword lists yet; we score by topic keywords.
    const topicScores = [];
    for (const [topicKey, topic] of Object.entries(subject.topics ?? {})) {
      const hits = keywordHits(text, topic.keywords ?? []);
      const topicScore = hits.length;
      topicScores.push({ topicKey, topic, hits, topicScore });
    }

    topicScores.sort((a, b) => b.topicScore - a.topicScore);
    const top = topicScores[0];
    const topicScore = top?.topicScore ?? 0;
    if (topicScore <= 0) continue;

    // Convert count to a conservative confidence.
    // Example: 1 hit => ~0.4; 2-3 hits => ~0.6-0.8; 4+ => high but capped.
    const baseSubjectConfidence = Math.min(0.95, 0.35 + topicScore * 0.18);

    // ID hint boosts electrical for Parts 1/3/4/5 in this repo's current dataset.
    let idBoost = 0;
    if (partNum !== null) {
      const electrical = subject.code === "aircraft_electrical";
      if (electrical && [1, 3, 4, 5].includes(partNum)) idBoost = 0.15;
      if (!electrical && [1, 3, 4, 5].includes(partNum)) idBoost = -0.05;
    }

    const confidence = Math.max(0, Math.min(0.99, baseSubjectConfidence + idBoost));
    if (confidence > best.confidence) {
      best = {
        subject_code: subject.code,
        subject_name: subject.name,
        topic_code: top.topic.code,
        topic_name: top.topic.name,
        confidence,
        evidence: {
          subjectKeywords,
          topicKeywords: top.hits,
          idPartHint: partNum,
        },
      };
    }
  }

  // If confidence is low, do not pretend: return unknown.
  if (best.confidence < 0.6) {
    return {
      subject_code: "unknown",
      subject_name: taxonomy.unknown.name,
      topic_code: "unknown",
      topic_name: "Unknown",
      classification_confidence: Number(best.confidence.toFixed(2)),
      evidence: best.evidence,
    };
  }

  return {
    subject_code: best.subject_code,
    subject_name: best.subject_name,
    topic_code: best.topic_code,
    topic_name: best.topic_name,
    classification_confidence: Number(best.confidence.toFixed(2)),
    evidence: best.evidence,
  };
}


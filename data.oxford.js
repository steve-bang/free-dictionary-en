const cheerio = require("cheerio");
const axios = require("axios");

const cache = new Map();
const CACHE_TTL = 1000 * 60 * 30;

const httpClient = axios.create({
  timeout: 10000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  }
});

const getCacheKey = (url) => `cache_${url.replace(/[^a-zA-Z0-9]/g, '_')}`;

const getFromCache = (key) => {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }
  cache.delete(key);
  return null;
};

const setCache = (key, data) => {
  cache.set(key, { data, timestamp: Date.now() });
  if (cache.size > 1000) {
    const now = Date.now();
    for (const [k, v] of cache.entries()) {
      if (now - v.timestamp > CACHE_TTL) {
        cache.delete(k);
      }
    }
  }
};

/**
 * Cleans and normalizes text extracted from HTML
 */
function cleanText(input) {
  if (typeof input !== "string") return "";

  return input
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .normalize("NFKC")
    .trim();
}

/**
 * Fetches verb forms from Wiktionary
 */
const fetchVerbs = async (word) => {
  const wiki = `https://simple.wiktionary.org/wiki/${word}`;
  const cacheKey = getCacheKey(wiki);
  const cached = getFromCache(cacheKey);
  
  if (cached) {
    return cached;
  }

  try {
    const response = await httpClient.get(wiki);
    const $ = cheerio.load(response.data);
    const verbs = [];

    $(".inflection-table tr td").each((index, cell) => {
      const cellElement = $(cell);
      const cellText = cellElement.text().trim();

      if (!cellText) return;

      const pElement = cellElement.find("p");
      if (pElement.length > 0) {
        const pText = pElement.text().trim();
        const parts = pText
          .split("\n")
          .map((p) => p.trim())
          .filter((p) => p);

        if (parts.length >= 2) {
          const type = parts[0];
          const text = parts[1];

          if (type && text) {
            verbs.push({ id: verbs.length, type, text });
          }
        } else {
          const htmlContent = pElement.html();
          if (htmlContent && htmlContent.includes("<br>")) {
            const htmlParts = htmlContent.split("<br>");
            if (htmlParts.length >= 2) {
              const type =
                $(htmlParts[0]).text().trim() ||
                htmlParts[0].replace(/<[^>]*>/g, "").trim();
              const textPart = htmlParts[1];
              const text =
                $(textPart).text().trim() ||
                textPart.replace(/<[^>]*>/g, "").trim();

              if (type && text) {
                verbs.push({ id: verbs.length, type, text });
              }
            }
          }
        }
      }
    });

    setCache(cacheKey, verbs);
    return verbs;
  } catch (error) {
    console.warn(`Failed to fetch verbs from ${wiki}:`, error.message);
    return [];
  }
};

/**
 * Fetches vocabulary data from Oxford Learner's Dictionary
 * Returns data matching the C# DictionaryResponse schema
 */
const fetchOxfordDictionary = async (entry) => {
  const url = `https://www.oxfordlearnersdictionaries.com/definition/english/${entry}`;
  const cacheKey = getCacheKey(url);
  const cached = getFromCache(cacheKey);
  
  if (cached) {
    return cached;
  }

  try {
    const [dictionaryResponse, verbs] = await Promise.allSettled([
      httpClient.get(url),
      fetchVerbs(entry)
    ]);

    if (dictionaryResponse.status === 'rejected' || dictionaryResponse.value.status !== 200) {
      throw new Error("Word not found");
    }

    const $ = cheerio.load(dictionaryResponse.value.data);
    const siteUrl = "https://www.oxfordlearnersdictionaries.com";

    // Extract headword
    const word = cleanText($(".headword").first().text());
    
    if (!word) {
      throw new Error("Word not found");
    }

    // Extract parts of speech - get unique values
    const posSet = new Set();
    $(".pos").each((i, el) => {
      const posText = cleanText($(el).text());
      if (posText) posSet.add(posText);
    });
    const pos = Array.from(posSet);

    // Extract pronunciation with audio - matching PronunciationModel schema
    const pronunciation = [];
    
    $(".pos-header").each((i, headerEl) => {
      const $header = $(headerEl);
      
      // Get the POS for this section
      const sectionPos = cleanText($header.find(".pos").first().text());
      
      // Find all phonetics in this section
      $header.find(".phonetics").each((j, phonEl) => {
        const $phonEl = $(phonEl);
        
        // Get region (UK/US) - maps to Lang property
        const region = cleanText($phonEl.find(".geo").text());
        
        // Get phonetic transcription - maps to Pron property
        const phon = cleanText($phonEl.find(".phon").text());
        
        // Get audio URL - maps to Url property
        const audioSrc = $phonEl.find("audio source").attr("src");
        
        if (phon) {
          pronunciation.push({
            pos: sectionPos || "",
            lang: region || "",
            url: audioSrc ? siteUrl + audioSrc : "",
            pron: phon
          });
        }
      });
    });

    // Extract definitions with examples - matching DefinitionModel schema
    const definition = [];
    
    $(".sense").each((index, senseEl) => {
      const $sense = $(senseEl);
      
      // Get the entry body to find POS
      const $entry = $sense.closest(".entry");
      const sensePos = cleanText($entry.find(".pos").first().text());
      
      // Get definition text
      const defText = cleanText($sense.find(".def").first().text());
      
      if (!defText) return;
      
      // Get source identifier (using webtop class or data attribute)
      const source = $entry.attr("data-src") || 
                     $entry.find(".webtop").attr("id") || 
                     "oxford";
      
      // Get translation if available (Oxford doesn't typically have translations in English version)
      const translation = "";
      
      // Get examples - matching Example schema
      const examples = [];
      $sense.find(".examples .x").each((i, exEl) => {
        const exampleText = cleanText($(exEl).text());
        if (exampleText) {
          examples.push({
            id: i,
            text: exampleText,
            translation: "" // Oxford English dictionary doesn't have translations
          });
        }
      });
      
      // Also check for examples in x-g containers
      $sense.find(".x-g .x").each((i, exEl) => {
        const exampleText = cleanText($(exEl).text());
        if (exampleText && !examples.some(ex => ex.text === exampleText)) {
          examples.push({
            id: examples.length,
            text: exampleText,
            translation: ""
          });
        }
      });
      
      definition.push({
        id: index,
        pos: sensePos,
        source: source,
        text: defText,
        translation: translation,
        example: examples
      });
    });

    // Build response matching C# DictionaryResponse schema
    const result = {
      word: word,
      pos: pos,
      verbs: verbs.status === 'fulfilled' ? verbs.value : [],
      pronunciation: pronunciation,
      definition: definition
    };

    setCache(cacheKey, result);
    return result;

  } catch (error) {
    console.error(`Failed to fetch from Oxford Dictionary:`, error.message);
    throw error;
  }
};

// Express route handler
app.get("/api/oxford/:entry", async (req, res) => {
  try {
    const entry = req.params.entry.toLowerCase().trim();
    
    if (!entry || entry.length === 0) {
      return res.status(400).json({ error: "Invalid entry parameter" });
    }

    const result = await fetchOxfordDictionary(entry);
    res.status(200).json(result);
    
  } catch (error) {
    if (error.message === "Word not found") {
      return res.status(404).json({ error: "Word not found" });
    }
    
    console.error('API Error:', error.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = { fetchOxfordDictionary };
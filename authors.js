/*
 * Author Profiles page
 * ---------------------------------------------------
 * 1. Loads authors.json and papers.json (made by build_data.py).
 * 2. While you type, shows matching author names. A name matches when every
 *    word you typed is the START of one of its words ("ta" finds "Tanja",
 *    "Tan Li" and "Mary Tate").
 * 3. Clicking a name shows the profile: points, rank, links (ORCID, Google
 *    Scholar, DBLP, only the ones the author has), whether an email is
 *    known (the address itself is never shown or stored), affiliations,
 *    top 3 collaborators and all of that author's papers (title, year,
 *    venue, DOI).
 * 4. The page address holds the author (authors.html?name=...), so profile
 *    links from the map popups work and pages can be bookmarked.
 */

const AUTHORS_PATH = "authors.json";
const PAPERS_PATH = "papers.json";

// How many names the drop-down list shows at most.
const MAX_SUGGESTIONS = 15;

const authorInput = document.getElementById("author-input");
const suggestionList = document.getElementById("author-suggestions");
const statusLine = document.getElementById("author-status");
const profileBox = document.getElementById("profile");

let authors = [];                    // every author (from authors.json)
let papers = [];                     // every paper (from papers.json)
let rankedCount = 0;                 // how many authors are in the ranking
let authorsByName = new Map();       // author name -> author
let shownAuthors = [];               // authors currently in the drop-down list
let highlightedIndex = -1;           // which list entry the arrow keys are on

/* ---------- Small helpers ---------- */

/**
 * Lower-cases text and removes accents, so "andre" finds "André".
 */
function normalizeText(text) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/**
 * Splits text into words (hyphens and dots also separate words).
 */
function splitWords(text) {
  return text.split(/[\s\-.'’]+/).filter(Boolean);
}

/**
 * Creates an element with optional CSS class and text. Using textContent
 * (instead of HTML) means names can never break the page.
 */
function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

/* ---------- Searching ---------- */

/**
 * Prepares every author for fast searching.
 */
function prepareSearch() {
  for (const author of authors) {
    author.words = splitWords(normalizeText(author.name));
    author.key = author.words.join(" ");
  }
}

/**
 * Returns the best-matching authors for what is typed: names that START
 * with the text first, then higher points, then alphabetical.
 */
function findAuthors(query) {
  const queryWords = splitWords(normalizeText(query));
  if (queryWords.length === 0) return [];

  const queryText = queryWords.join(" ");
  const startsWithQuery = (author) => (author.key.startsWith(queryText) ? 0 : 1);

  return authors
    .filter((author) => queryWords.every((q) => author.words.some((w) => w.startsWith(q))))
    .sort(
      (a, b) =>
        startsWithQuery(a) - startsWithQuery(b) ||
        (b.points || 0) - (a.points || 0) ||
        a.name.localeCompare(b.name)
    )
    .slice(0, MAX_SUGGESTIONS);
}

/* ---------- Drop-down list ---------- */

function hideSuggestions() {
  suggestionList.hidden = true;
  shownAuthors = [];
  highlightedIndex = -1;
}

/**
 * Marks one list entry as highlighted (used by the arrow keys).
 */
function highlight(index) {
  highlightedIndex = index;
  [...suggestionList.children].forEach((item, i) => {
    item.classList.toggle("highlighted", i === index);
  });
}

/**
 * Draws one list entry: the name, and below it the points and first affiliation.
 */
function buildSuggestion(author) {
  const item = createElement("li");
  item.append(createElement("div", "", author.name));

  const details = [];
  details.push(author.rank ? `${author.points} points · rank ${author.rank}` : `${author.points} points`);
  if (author.affiliations.length > 0) details.push(author.affiliations[0].name);
  if (details.length > 0) item.append(createElement("div", "meta", details.join(" · ")));

  item.addEventListener("click", () => showProfile(author));
  return item;
}

/**
 * Redraws the drop-down list for what is typed right now.
 */
function renderSuggestions() {
  shownAuthors = findAuthors(authorInput.value);
  suggestionList.innerHTML = "";
  highlightedIndex = -1;

  if (shownAuthors.length === 0) {
    suggestionList.hidden = true;
    return;
  }
  shownAuthors.forEach((author) => suggestionList.append(buildSuggestion(author)));
  suggestionList.hidden = false;
}

/**
 * Arrow keys move through the list, Enter opens the highlighted (or first) name.
 */
function handleKeys(event) {
  if (shownAuthors.length === 0) return;

  if (event.key === "ArrowDown") {
    event.preventDefault();
    highlight(Math.min(highlightedIndex + 1, shownAuthors.length - 1));
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    highlight(Math.max(highlightedIndex - 1, 0));
  } else if (event.key === "Enter") {
    event.preventDefault();
    showProfile(shownAuthors[Math.max(highlightedIndex, 0)]);
  } else if (event.key === "Escape") {
    hideSuggestions();
  }
}

/* ---------- Profile ---------- */

/**
 * One box with a big value and a small label, e.g. "96" / "points".
 */
function buildStat(value, label) {
  const stat = createElement("div", "stat");
  stat.append(createElement("div", "value", value), createElement("div", "label", label));
  return stat;
}

/**
 * The row of boxes at the top: points, rank, number of papers.
 */
function buildStats(author) {
  const stats = createElement("div", "stats");
  stats.append(
    buildStat(author.points, "points"),
    buildStat(author.rank ? `#${author.rank} of ${rankedCount}` : "not ranked", "rank among ranked authors"),
    buildStat(author.papers.length, author.papers.length === 1 ? "paper" : "papers")
  );
  return stats;
}

/**
 * The links line: ORCID · Google Scholar · DBLP. Only the links this
 * author actually has are listed; nothing is shown when there are none.
 */
function buildLinks(author) {
  // An author can have several ORCID iDs: then they are "ORCID 1", "ORCID 2", ...
  const orcids = author.orcid || [];
  const links = [
    ...orcids.map((url, i) => ({ label: orcids.length > 1 ? `ORCID ${i + 1}` : "ORCID", url })),
    { label: "Google Scholar", url: author.scholar },
    { label: "DBLP", url: author.dblp },
  ].filter((link) => link.url);

  const line = createElement("p", "profile-links");
  links.forEach((link, i) => {
    if (i > 0) line.append(" · ");
    const a = createElement("a", "", link.label);
    a.href = link.url;
    a.target = "_blank";
    a.rel = "noopener";
    line.append(a);
  });
  return links.length > 0 ? line : null;
}

/**
 * "Email" followed by a tick (an email address is known for this author)
 * or a crossed-out circle (none known). The address itself is never shown.
 */
function buildEmail(author) {
  const line = createElement("p", "profile-email");
  const mark = createElement("span", author.hasEmail ? "mark yes" : "mark no", author.hasEmail ? "✓" : "⊘");
  mark.title = author.hasEmail ? "Email address known" : "No email address known";
  line.append("Email ", mark);
  return line;
}

/**
 * The top 3 co-authors, with the number of shared papers. Each one links
 * to their own profile when we have it.
 */
function buildCollaborators(author) {
  const section = createElement("div");
  section.append(createElement("h3", "", "Top collaborators"));

  if (author.collaborators.length === 0) {
    section.append(createElement("p", "profile-note", "No collaborators found."));
    return section;
  }

  const list = createElement("ol", "collaborator-list");
  for (const c of author.collaborators) {
    const item = createElement("li");
    const other = authorsByName.get(c.name);
    if (other) {
      const link = createElement("a", "", c.name);
      link.href = `?name=${encodeURIComponent(c.name)}`;
      link.addEventListener("click", (event) => {
        event.preventDefault();
        showProfile(other);
        window.scrollTo(0, 0);
      });
      item.append(link);
    } else {
      item.append(c.name);
    }
    item.append(createElement("span", "profile-note", ` (${c.shared} shared ${c.shared === 1 ? "paper" : "papers"})`));
    list.append(item);
  }
  section.append(list);
  return section;
}

/**
 * The affiliation chips. Each affiliation is { name, map?, sources }
 * (see build_data.py): "map" is the institution's name on the map and makes
 * the chip a link to it; "sources" is how many of DBLP, ORCID and OpenAlex
 * name it (1-3). They come sorted, most sources first, and each level has
 * its own shade (chip.sources-1/2/3 in style.css).
 */
function buildAffiliations(author) {
  const section = createElement("div");
  section.append(createElement("h3", "", "Affiliations"));

  if (author.affiliations.length === 0) {
    section.append(createElement("p", "profile-note", "No affiliation data for this author."));
    return section;
  }

  const chips = createElement("ul", "chips");
  for (const affiliation of author.affiliations) {
    const item = createElement("li");
    const level = ` sources-${affiliation.sources || 1}`;
    if (affiliation.map) {
      const link = createElement("a", "chip" + level, affiliation.name);
      link.href = `index.html?institution=${encodeURIComponent(affiliation.map)}`;
      link.title = "Show on the map";
      item.append(link);
    } else {
      item.append(createElement("span", "chip" + level, affiliation.name));
    }
    item.title = `Named by ${affiliation.sources || 1} of 3 sources (DBLP, ORCID, OpenAlex)`;
    chips.append(item);
  }
  section.append(chips);
  return section;
}

/**
 * "Papers per venue": how many of the author's papers appeared in each
 * venue, most first (counted from papers.json, same venues as the map).
 */
function buildVenueCounts(author) {
  const counts = new Map();
  for (const index of author.papers) {
    const venue = papers[index].venue;
    counts.set(venue, (counts.get(venue) || 0) + 1);
  }

  const section = createElement("div");
  section.append(createElement("h3", "", "Papers per venue"));
  const list = createElement("ul", "venue-counts");
  [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .forEach(([venue, count]) => {
      const item = createElement("li", "", venue);
      item.append(createElement("span", "profile-note", ` (${count})`));
      list.append(item);
    });
  section.append(list);
  return section;
}

/**
 * One paper: title, then year · venue · DOI.
 */
function buildPaper(paper) {
  const item = createElement("li");
  item.append(createElement("div", "paper-title", paper.title));

  const meta = createElement("div", "paper-meta", `${paper.year} · ${paper.venue}`);
  if (paper.doi) {
    const link = createElement("a", "", `doi:${paper.doi}`);
    link.href = `https://doi.org/${encodeURI(paper.doi)}`;
    link.target = "_blank";
    link.rel = "noopener";
    meta.append(" · ", link);
  }
  item.append(meta);
  return item;
}

/**
 * The list of all the author's papers, newest first.
 */
function buildPaperList(author) {
  const section = createElement("div");
  section.append(createElement("h3", "", `Papers (${author.papers.length})`));

  const list = createElement("ul");
  list.id = "paper-list";
  author.papers
    .map((index) => papers[index])
    .sort((a, b) => b.year - a.year || a.title.localeCompare(b.title))
    .forEach((paper) => list.append(buildPaper(paper)));

  section.append(list);
  return section;
}

/**
 * Shows the whole profile of one author.
 */
function showProfile(author) {
  hideSuggestions();
  authorInput.value = author.name;
  window.history.replaceState(null, "", `?name=${encodeURIComponent(author.name)}`);

  profileBox.innerHTML = "";
  profileBox.append(createElement("h2", "", author.name), buildStats(author));

  profileBox.append(
    createElement(
      "p",
      "profile-note",
      `Authorship: ${author.first} first, ${author.middle} middle, ${author.last} last.`
    )
  );

  const links = buildLinks(author);
  if (links) profileBox.append(links);
  profileBox.append(buildEmail(author));

  profileBox.append(buildAffiliations(author), buildCollaborators(author), buildVenueCounts(author), buildPaperList(author));
  profileBox.hidden = false;
}

/* ---------- Loading ---------- */

/**
 * Loads a JSON file.
 */
function fetchJson(path) {
  return fetch(path, { cache: "no-cache" }).then((response) => {
    if (!response.ok) throw new Error(`Could not load ${path} (HTTP ${response.status}).`);
    return response.json();
  });
}

/**
 * Opens the author named in the page address (?name=...), if there is one.
 */
function openAuthorFromUrl() {
  const name = new URLSearchParams(window.location.search).get("name");
  if (!name) return;

  const author = authorsByName.get(name);
  if (author) showProfile(author);
  else statusLine.textContent = `No author called "${name}" was found.`;
}

function loadData() {
  Promise.all([fetchJson(AUTHORS_PATH), fetchJson(PAPERS_PATH)])
    .then(([authorData, paperData]) => {
      authors = authorData.authors;
      rankedCount = authorData.rankedCount;
      papers = paperData;
      authorsByName = new Map(authors.map((a) => [a.name, a]));

      prepareSearch();
      authorInput.disabled = false;
      authorInput.focus();
      statusLine.textContent = `${authors.length} authors available.`;
      openAuthorFromUrl();
    })
    .catch((err) => {
      console.error(err);
      statusLine.textContent = err.message;
    });
}

authorInput.addEventListener("input", renderSuggestions);
authorInput.addEventListener("keydown", handleKeys);
authorInput.addEventListener("focus", () => {
  if (authorInput.value.trim() !== "") renderSuggestions();
});

// Clicking anywhere outside the search box closes the drop-down list.
document.addEventListener("click", (event) => {
  if (!event.target.closest(".search-wrap")) hideSuggestions();
});

loadData();

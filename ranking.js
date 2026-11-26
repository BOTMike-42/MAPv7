/*
 * Author Ranking page
 * ---------------------------------------------------
 * Loads authors.json (made by build_data.py), keeps the authors that have
 * a rank (the people in PeopleToBeRanked.csv), and lists them in a table. Authors with equal points share a rank.
 * Clicking a column title sorts the table by that column (click again to
 * reverse it). The RANK numbers never change: they always come from the
 * points, only the order of the rows changes.
 * Clicking a name opens that author's profile.
 */

const AUTHORS_PATH = "authors.json";

// The sortable columns. startsDescending: true means the first click puts
// the biggest numbers on top (false = A-Z / smallest first).
const SORT_COLUMNS = {
  rank: { value: (a) => a.rank, startsDescending: false },
  name: { value: (a) => a.name, startsDescending: false },
  points: { value: (a) => a.points, startsDescending: true },
  first: { value: (a) => a.first, startsDescending: true },
  middle: { value: (a) => a.middle, startsDescending: true },
  last: { value: (a) => a.last, startsDescending: true },
};

const statusLine = document.getElementById("ranking-status");
const table = document.getElementById("ranking-table");
const headers = [...table.querySelectorAll("th[data-sort]")];

let rankedAuthors = [];       // the authors that have points
let sortKey = "rank";         // column the table is sorted by right now
let sortDescending = false;   // direction of that sort

/**
 * Creates a table cell with optional CSS class and text.
 */
function createCell(text, className) {
  const cell = document.createElement("td");
  cell.textContent = text;
  if (className) cell.className = className;
  return cell;
}

/**
 * Creates one table row for an author. The name is a link to the profile page.
 */
function buildRow(author) {
  const row = document.createElement("tr");

  const nameCell = document.createElement("td");
  const link = document.createElement("a");
  link.textContent = author.name;
  link.href = `authors.html?name=${encodeURIComponent(author.name)}`;
  nameCell.append(link);

  row.append(
    createCell(`#${author.rank}`),
    nameCell,
    createCell(author.points, "number"),
    createCell(author.first, "number"),
    createCell(author.middle, "number"),
    createCell(author.last, "number")
  );
  return row;
}

/**
 * Compares two authors for the current sort. Equal values fall back to
 * rank, then name, so the order is always stable.
 */
function compareAuthors(a, b) {
  const getValue = SORT_COLUMNS[sortKey].value;
  const x = getValue(a);
  const y = getValue(b);

  let result = typeof x === "string" ? x.localeCompare(y) : x - y;
  if (sortDescending) result = -result;

  return result || a.rank - b.rank || a.name.localeCompare(b.name);
}

/**
 * Shows a small arrow on the title of the column that is sorted.
 */
function updateHeaders() {
  for (const header of headers) {
    const arrow = header.dataset.sort === sortKey ? (sortDescending ? " ▼" : " ▲") : "";
    header.textContent = header.dataset.label + arrow;
  }
}

/**
 * Redraws the table in the current order.
 */
function renderTable() {
  const sorted = [...rankedAuthors].sort(compareAuthors);
  table.tBodies[0].replaceChildren(...sorted.map(buildRow));
  updateHeaders();
}

/**
 * Called when a column title is clicked: sorts by that column, or
 * reverses the order if it is already the sorted column.
 */
function handleHeaderClick(header) {
  const key = header.dataset.sort;

  if (key === sortKey) {
    sortDescending = !sortDescending;
  } else {
    sortKey = key;
    sortDescending = SORT_COLUMNS[key].startsDescending;
  }
  renderTable();
}

function loadRanking() {
  fetch(AUTHORS_PATH, { cache: "no-cache" })
    .then((response) => {
      if (!response.ok) throw new Error(`Could not load ${AUTHORS_PATH} (HTTP ${response.status}).`);
      return response.json();
    })
    .then((data) => {
      rankedAuthors = data.authors.filter((author) => author.rank !== undefined);

      headers.forEach((header) => {
        header.dataset.label = header.textContent;
        header.addEventListener("click", () => handleHeaderClick(header));
      });

      renderTable();
      table.hidden = false;
      statusLine.textContent =
        `${rankedAuthors.length} ranked authors. Click a column title to sort by it ` +
        `(ranks stay the same). Click a name to see the profile.`;
    })
    .catch((err) => {
      console.error(err);
      statusLine.textContent = err.message;
    });
}

loadRanking();

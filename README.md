# n8n-nodes-geopulse

n8n community nodes for [GeoPulse](https://github.com/tess1o/geopulse), the self-hosted location timeline:

- **GeoPulse**: GPS points, timeline, statistics, location ingestion, exports, share links, friends, profile and custom API calls. Usable as an AI agent tool.
- **GeoPulse Trigger**: a polling trigger for arrivals, departures, new trips, new GPS points and missing location data.

The endpoints were checked against **GeoPulse v2.2.1**: its OpenAPI specification, backend code and API documentation.

This is an independent project. It is not affiliated with GeoPulse.

## Installation

### From npm

In n8n, open **Settings → Community Nodes → Install** and enter `n8n-nodes-geopulse`.

### Manual installation (Docker)

1. Copy the package file into the container (here named `n8n`):

```bash
docker cp n8n-nodes-geopulse-0.1.0.tgz n8n:/tmp/
```

2. Install it in `~/.n8n/nodes`:

```bash
docker exec -it n8n sh -c "mkdir -p ~/.n8n/nodes && cd ~/.n8n/nodes && npm install --legacy-peer-deps /tmp/n8n-nodes-geopulse-0.1.0.tgz"
```

3. Restart n8n:

```bash
docker restart n8n
```

## Credentials

Create a **GeoPulse API** credential with these fields:

| Field | Description |
|---|---|
| Base URL | Address of your GeoPulse server, without `/api`, for example `https://geopulse.example.com`. Must be http(s) with no user, query or fragment. Trailing slashes are removed. |
| API Token | A personal API token. To create one in GeoPulse, go to **Menu → Profile → Security → API tokens → Create Token**. The token is shown only once. |
| GPS Source Token | Optional. The token of a **Home Assistant** location source. It is used only by **Ingestion → Send Location**, instead of the API token. |

The token is sent only in the `Authorization: Bearer` header, never in a URL or query string. It is sent only to `<Base URL>/api/`. The credential test calls `GET /api/v1/api-tokens/current`, which works with a token of any scope.

### Token scopes

GeoPulse tokens have fixed scopes. Give each token only what it needs:

| Use | Scopes |
|---|---|
| Reading (Location, Timeline, Friends, Share Link → Get Many, User) and the **Trigger** | `read` |
| Export | `export` (add `read` if the same token also reads data) |
| Creating or deleting share links, Regenerate Timeline, other writes through Custom API Call | `write` |
| Ingestion → Send Location | Use a **separate** token with `gps:ingest`, connected to a Home Assistant location source. Alternatively, set a GPS source token. |

If a scope is missing, the node fails with a message that names it, for example: *The API token is missing the 'write' scope required for this operation*.

#### Sending locations

GeoPulse accepts personal API tokens on its Home Assistant ingestion endpoint. There are two setups:

- **API token.** Create a token with the `gps:ingest` scope. Then add a location source of type **Home Assistant** in **Location Sources**, choose **GeoPulse integration** and connect it to that token. Without the connected source, GeoPulse answers `403 GPS_SOURCE_NOT_CONNECTED`.
- **Source token.** Create a Home Assistant location source with its own token and put that token in **GPS Source Token**.

## GeoPulse node

| Resource | Operation | Endpoint |
|---|---|---|
| Location | Get Last Location | `GET /api/v1/gps/points/latest` |
| | Get GPS Points (period, Return All / Limit) | `GET /api/v1/gps/points` |
| | Get Point Place (place name of a point ID) | `GET /api/v1/gps/points/{id}/location` |
| | Get Path | `GET /api/v1/gps/points/path` |
| | Get Summary | `GET /api/v1/gps/points/summary` |
| | Get Current Status | `GET /api/v1/users/me/status` |
| Timeline | Get Timeline (stays, trips, data gaps in chronological order) | `GET /api/v1/timeline` |
| | Get Stays / Get Trips / Get Data Gaps | `GET /api/v1/timeline` |
| | Get Statistics | `GET /api/v1/statistics` |
| | Regenerate Timeline (whole timeline only, optional wait) | `POST /api/v1/timeline/jobs`, `GET /api/v1/timeline/jobs/{id}` |
| Ingestion | Send Location (one point or a JSON array) | `POST /api/v1/gps/ingest/home-assistant/batch` |
| Export | Create Export (GeoPulse ZIP, GPX, OwnTracks, GeoJSON, CSV; optional wait and download) | `POST /api/v1/exports` |
| | Get Export Status | `GET /api/v1/exports/{id}` |
| | Download Export (n8n binary data) | `GET /api/v1/exports/{id}/content` |
| Share Link | Get Many / Create (password, expiration) / Delete | `/api/v1/share-links` |
| Friend | Get Many / Get Location | `GET /api/v1/friends`, `GET /api/v1/friends/{id}/location` |
| User | Get Profile | `GET /api/v1/users/me` |
| Custom API Call | Make a Request (method, path under `/api/`, query, JSON body) | any path under `/api/` |

Notes:

- **Dates.** Dates are accepted as n8n dates or ISO 8601. A value without an offset, such as `2025-06-01 08:00`, is read in the **Time Zone** option or, if that is empty, in the workflow time zone. GeoPulse returns UTC.
- **Lists.** Lists are always arrays. **Split Into Items** is on by default: each element becomes one item. When it is off, the node returns a single item `{ items, count }`.
- **Timeline items.** Timeline items get `type` (`stay`, `trip` or `dataGap`), `startTime` and `endTime`. GeoPulse durations are in seconds.
- **Not supported by GeoPulse 2.2.1.** GeoPulse has no endpoint to read a single GPS point by ID, so the node offers **Get Point Place** instead. GeoPulse also cannot regenerate the timeline for a single period: **Regenerate Timeline** rebuilds the whole timeline.
- **Send Location.** It uses the Home Assistant batch format: up to 1000 points per request, speed in m/s, battery from 0 to 100. Larger arrays are split into several requests. The output reports `accepted`, `saved`, `duplicate` and `filtered`.
- **Waiting.** The poll interval and the timeout of **Wait For Completion** must be between 1 second and 24 hours, also when they are set by an expression.
- **Errors.** Failed requests become errors with GeoPulse's `code` and `detail`. With **Continue On Fail**, the node outputs `{ error }` and keeps the link to the input item.

## GeoPulse Trigger

A polling trigger. Choose an event:

| Event | When it fires |
|---|---|
| Arrived At Place | A new stay started. GeoPulse recognizes a stay only after the minimum stay duration in its timeline settings, and it updates the timeline every few minutes, so the event comes late. |
| Left Place | A stay ended. It fires only when the next timeline element (trip or stay) starts, so it comes some time after you leave. |
| New Trip | A trip was completed. It fires only when the next element (usually a stay) starts. |
| Location Updated | A new GPS point was received. |
| No Location Data | No GPS point for more than N minutes. It fires once, then again only after data resumes and stops again. |

- **Place filter.** You can filter by **radius** (center latitude/longitude and meters) or, for stays, by **place name**. Place name matches when the GeoPulse place name contains your text. Trips match by their start or end point.
- **First run.** The first poll only saves the current state, so you do not receive the whole history.
- **Duplicates.** Events are deduplicated. A stay or trip that a timeline regeneration recalculates is recognized by its start time and place and does not fire again.
- **Manual test.** In a manual test, the trigger returns the most recent matching element, so you can see the data structure.

Example output (Arrived At Place):

```json
{
  "event": "arrivedAtPlace",
  "type": "stay",
  "startTime": "2025-06-01T08:12:40Z",
  "endTime": "2025-06-01T09:30:00.000Z",
  "id": 18342,
  "timestamp": "2025-06-01T08:12:40Z",
  "stayDuration": 4640,
  "locationName": "Home",
  "favoriteId": 12,
  "city": "Milan",
  "country": "Italy",
  "latitude": 45.4642,
  "longitude": 9.19
}
```

## Security

- Use **HTTPS** for the Base URL. Redirects are not followed: if the server redirects, the node stops and asks you to set the final address.
- Every request must complete within 30 seconds; export downloads within 10 minutes. JSON responses are limited to 50 MB and export files to 1 GB.
- Location data is sensitive. The nodes write no logs. Tokens, share link passwords and query strings are removed from error messages and from `continueOnFail` output. Password fields are removed from the output, also in Custom API Call.
- Paginated reads stop after 200 pages, so a server that ignores paging cannot loop forever.
- Share links are **public**: set a password and an expiration whenever possible.

## Development

```bash
npm install
npm run build
npm run lint
npm test
```

The tests use vitest and a fake GeoPulse HTTP server.

## Support

If this project is useful to you, you can [buy me a coffee](https://buymeacoffee.com/FDalCol).

## License

[MIT](LICENSE)

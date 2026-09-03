# scholion-places

An API for places worth remembering: where the flowers were, which ones and in
what season, and which restaurants along the road were any good.

A place is visited more than once. The field that is full of poppies in April
has thistles by August, and a single record has to hold both — with the photos
of each, and the ability to correct the one you got wrong.

## Two layers

```
   place.json      the record. Structured, versioned, the only thing anything reads.
       │
       │  render.ts
       ▼
   index.md        generated. What the static site publishes. Nobody edits it.
   + the photos
```

Nothing reads the Markdown back. The search index is built from the JSON, the
API mutates the JSON, and the Markdown is output — which means a change to the
layout is `POST /render?all=true` and one commit, not a migration. That
separation is the whole design; it was learned from a sibling service where
correcting a template meant correcting every published file by hand.

The consequence, and it is deliberate: **hand edits to `index.md` are lost on
the next render.** The file says so in a YAML comment. The prose of a place
lives in the `body` field of its record, which you can edit through the API or
by opening `place.json` in an editor — the service notices the mtime and
re-reads it.

## A record on disk

```
content/places/fonte-da-pipa/
  place.json                            the record
  index.md                              generated
  2026-04-12-papoila-das-searas.jpg
  2026-08-31-cardo.jpg
```

```json
{
  "slug": "fonte-da-pipa",
  "title": "Fonte da Pipa",
  "kind": ["flores"],
  "tags": ["serra-da-estrela"],
  "coords": { "lat": 40.32611, "lon": -7.61389 },
  "body": "Estaciona-se na berma larga a seguir à curva.",
  "entries": [
    {
      "id": "e7f3a2",
      "date": "2026-04-12",
      "type": "sighting",
      "by": "thiago",
      "species": ["papoila-das-searas"],
      "note": "campo todo vermelho no lado sul",
      "photos": [{ "id": "p2c81f", "file": "2026-04-12-papoila-das-searas.jpg" }]
    }
  ]
}
```

Entries and photos carry short opaque ids. Not dates, not positions: two visits
on one day are ordinary, and correcting a date must not change what you are
pointing at. Without stable ids there is no way to express "fix that visit",
which is the operation this collection needs most.

## The API

```
GET    /health                                        no key required
GET    /me                                            what your key may do

GET    /places                q, kind, tag, species, month, near, radius_km,
                              since, until, limit, offset
POST   /places
GET    /places/{slug}
PATCH  /places/{slug}
DELETE /places/{slug}
POST   /places/{slug}/rename

GET    /places/{slug}/entries
POST   /places/{slug}/entries
GET    /places/{slug}/entries/{id}
PATCH  /places/{slug}/entries/{id}
DELETE /places/{slug}/entries/{id}

POST   /photos                                        multipart, field "file"
POST   /places/{slug}/entries/{id}/photos
PATCH  /places/{slug}/entries/{id}/photos/{photoId}
DELETE /places/{slug}/entries/{id}/photos/{photoId}

GET    /species
GET    /tags
POST   /render?all=true
POST   /reindex
```

`month=4` asks the question the collection exists for: what is in flower here in
April, across every year it has been recorded. Combine it with
`near=40.32611,-7.61389&radius_km=2` and you have the whole point of the thing
in one request.

### Correcting things

Editing a place is `PATCH /places/{slug}`. Adding a visit is
`POST /places/{slug}/entries`. Fixing a visit you recorded wrongly is `PATCH` or
`DELETE` on that entry, by its id.

Deletion is a normal operation here, unlike in services that talk to systems
which cannot undo. Everything is committed to git, so removing an entry rewrites
the record and the previous version stays in the history. What a given caller
may reach is a separate question — see the ACL below.

### Concurrent editing

`GET /places/{slug}` returns an `ETag`. `PATCH` and `DELETE` honour `If-Match`
and answer **409** if the record moved since you read it. There are two writers
— whatever client you point at this, and you with a text editor — so a lost
update is a matter of when, not whether.

### Photos

Upload and attach are two steps:

```sh
id=$(curl -sS -F file=@papoila.jpg http://localhost:8010/photos | jq -r .id)
curl -sS -X POST http://localhost:8010/places/fonte-da-pipa/entries \
  -H 'Content-Type: application/json' \
  -d "{\"date\":\"2026-04-12\",\"species\":[\"papoila-das-searas\"],\"photos\":[\"$id\"]}"
```

Two steps because whoever holds the photo does not always know yet where it
belongs — a phone on a trail sends the picture first and works out the place
afterwards. A staged photo nobody claims expires after a day, because rubbish in
a git repository is forever.

Every upload is re-encoded with ffmpeg to `PHOTO_MAX_PX` on its long side, which
also drops the EXIF block and the GPS fix inside it. This is not an
optimisation: git never forgets a blob, so the resolution cap is the only
control over how large the repository becomes, and it cannot be applied
retroactively.

`POST /photos` with `Accept: text/plain` answers with one short line instead of
JSON. That is for a media pipeline that pastes the response into a message for a
model to read.

## Access

`acl.json` (gitignored, `chmod 600`; see `acl.example.json`) names the
principals and what each may do. Identity is the `X-Api-Key` header and nothing
else — never a field in the body, so a caller cannot say who it is in the same
breath as what it wants.

In deployment the header is stamped by the reverse proxy, one `location` per
principal, so the client holds no credential at all and cannot promote itself by
sending a different key: the proof of identity is the path the request arrived
on.

A denied operation is left out of what `GET /me` reports, not merely refused
when called. Telling a client not to use a capability it can see is a
suggestion; not showing it is a boundary.

The file is re-read when its mtime moves — adding a principal needs no restart.
A half-saved edit keeps the previous rules in force rather than locking everyone
out.

## Where the files go

The service writes into a clone of the content repository and commits with an
explicit pathspec, never `add -A`. The order is the one that survives a
repository changing underneath it: validate, write, add, commit, `pull
--rebase`, push. Everything that touches git goes through one queue.

Commit and response are synchronous; the push happens in the background with a
retry. Once the commit exists the record is safe, and a slow network should not
make saving a flower feel slow.

## Running it

```sh
cp .env.example .env          # then fill in VAULT_DIR and chmod 600
cp acl.example.json acl.json  # then generate real keys and chmod 600
git clone --filter=blob:none <content-repo> vault
bun test
bun run server.ts
```

Requires Bun (for `Bun.YAML` and `bun:sqlite` with FTS5) and `ffmpeg` on the
path. No other dependencies.

## Pointing a bot at it

Nothing in this repository knows about any particular client, and that is a
property worth keeping — `grep -ri` for a bot's name should come back empty. A
new consumer is a principal in `acl.json`, a `location` in the proxy, and
whatever configuration that client needs on its own side. None of it is code.

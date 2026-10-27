# 栖卷 QiJuan

书有归处，人有闲读。

Self-hosted library for EPUB and PDF. The catalog is a SQLite file in `./data`.

## Run

Node.js 22 or newer.

```bash
npm install
npm run dev
```

Open http://127.0.0.1:5173. The first visit creates an administrator and a library. The API is http://127.0.0.1:8080.

```bash
npm run build
npm start
```

```bash
docker compose up --build
```

`npm start` serves the built site on port 8080. Compose keeps data in the `qijuan-data` volume.

```bash
npm run ci
npm run test:acceptance
```

## Docs

- [Development and configuration](docs/development.md)
- [Backup](docs/backup.md) and [recovery](docs/recovery.md)
- [OPDS](docs/opds.md)
- [Export](docs/export.md)
- [Upgrades](docs/upgrades.md)
- [Limitations](docs/limitations.md)

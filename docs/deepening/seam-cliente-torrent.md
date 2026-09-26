# Seam del cliente torrent

Estado: decidido, sin implementar. Se implementa cuando haya un segundo cliente torrent concreto que soportar; hasta entonces no se toca código ni `CONTEXT.md`, que describen lo que hay (solo qBittorrent).

## Veredicto

Soportar otro cliente torrent es sencillo. El bot solo necesita dos cosas del cliente: listar los torrents (`hash`, `name`) y, dado un hash, obtener el texto que relaciona el torrent con su página en el **Site**. Los consumidores ya dependen de ese contrato estrecho y no de la clase entera: `src/torrent-thanks.ts` usa `Pick<QBittorrentClient, "getTorrentComment" | "getTorrentCommentWithRetry">` y `src/scanner.ts` usa `Pick<QBittorrentClient, "listTorrents">`. El webhook tampoco depende del cliente: toma el hash del `downloadId` de Radarr/Sonarr (`src/webhook-server.ts`, `extractHash`), que es el info hash en cualquier cliente.

El riesgo no está en el código sino en el cliente: tiene que guardar en algún campo la URL del torrent en el Site.

## Decisiones

**Soporte genérico.** No se diseña para un cliente concreto. Esta nota fija qué debe cumplir cualquier cliente para poder soportarse.

**Un solo cliente por despliegue.** El bot es single-tenant, de un solo **Operator**. Soportar varios clientes a la vez obligaría a enrutar el webhook según el cliente de origen y a combinar el scan, sin un caso real que lo pida. Quien tenga dos clientes despliega dos instancias.

**El adapter devuelve texto en bruto; el match con el Site se queda en el núcleo.** Cada adapter devuelve los textos donde su cliente puede guardar la URL del torrent en el Site: una o varias piezas (el comment en qBittorrent; comment y campos custom en otros clientes). El núcleo sigue cruzando esos textos con los `base_url` configurados (`matchSite` en `src/torrent-thanks.ts`). Ese cruce depende del **Engine** (el patrón `/torrents/(\d+)`); si lo hiciera el adapter, cada adapter tendría que conocer el Engine y reimplementar el match.

**Restricción dura: el cliente debe guardar la URL del Site con el id del torrent.** La URL de announce, que exponen todos los clientes, no basta: no suele llevar el id numérico del torrent en el Site, y el **Thanks** lo necesita. Obtener el id por otra vía (buscar el hash en el Site, por ejemplo) sería otro proyecto, dependiente del Engine y con riesgo de baneo en trackers privados. Un cliente que no guarde esa URL no se soporta.

**El cliente se elige con una variable explícita.** `TORRENT_CLIENT`, con `qbittorrent` por defecto para no romper despliegues existentes. Se descarta inferirlo de qué variables estén presentes: se vuelve ambiguo en cuanto alguien deja variables de dos clientes.

**Métricas con nombre genérico y etiqueta `client`.** Al llegar el segundo cliente, `tracker_qbittorrent_api_duration_seconds` y `tracker_qbittorrent_api_errors_total` pasan a `tracker_torrent_client_api_duration_seconds` y `tracker_torrent_client_api_errors_total`, con una etiqueta `client`. Rompe los dashboards una vez; una familia de métricas por cliente los rompería con cada cliente nuevo.

## Qué se toca al implementarlo

- **Contrato.** Un tipo `TorrentClient` con `listTorrents()` y la operación que devuelve los textos candidatos para un hash. Hoy no existe porque solo hay una implementación; `CommentSource` y los `Pick<>` son su forma actual.
- **Retry con backoff.** `getTorrentCommentWithRetry` vive dentro de `src/qbittorrent.ts`, pero esperar a que el cliente tenga el texto tras un grab vale para cualquier cliente. Sale del adapter y lo envuelve desde fuera.
- **Config.** `src/config.ts` lee `QBIT_*` en `qbittorrentConfig` y expone `qbittorrent: QBittorrentConfig | null`. Pasa a leer `TORRENT_CLIENT` y la configuración del cliente elegido.
- **Wiring.** `qbittorrentClient()` en `src/index.ts` pasa a construir la implementación elegida; también cambian el volcado de configuración y el bloque de uso, que listan las variables `QBIT_*`.
- **Métricas.** El renombrado descrito arriba, en `src/metrics.ts`.
- **Vocabulario.** La definición de **Torrent** en `CONTEXT.md` nombra a qBittorrent y al comment como la única relación entre hash e id del Site; pasa a hablar del cliente torrent y de los textos que devuelve el adapter.

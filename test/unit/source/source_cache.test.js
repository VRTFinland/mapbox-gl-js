import {test} from '../../util/test.js';
import SourceCache from '../../../src/source/source_cache.js';
import {create, setType} from '../../../src/source/source.js';
import Tile from '../../../src/source/tile.js';
import {QueryGeometry} from '../../../src/style/query_geometry.js';
import {OverscaledTileID} from '../../../src/source/tile_id.js';
import Transform from '../../../src/geo/transform.js';
import LngLat from '../../../src/geo/lng_lat.js';
import Point from '@mapbox/point-geometry';
import {Event, ErrorEvent, Evented} from '../../../src/util/evented.js';
import {extend} from '../../../src/util/util.js';
import browser from '../../../src/util/browser.js';

// Add a mocked source type for use in these tests
function MockSourceType(id, sourceOptions, _dispatcher, eventedParent) {
    // allow tests to override mocked methods/properties by providing
    // them in the source definition object that's given to Source.create()
    class SourceMock extends Evented {
        constructor() {
            super();
            this.id = id;
            this.minzoom = 0;
            this.maxzoom = 22;
            extend(this, sourceOptions);
            this.setEventedParent(eventedParent);
            if (sourceOptions.hasTile) {
                this.hasTile = sourceOptions.hasTile;
            }
        }
        loadTile(tile, callback) {
            if (sourceOptions.expires) {
                tile.setExpiryData({
                    expires: sourceOptions.expires
                });
            }
            setTimeout(callback, 0);
        }
        loaded() {
            return true;
        }
        onAdd() {
            if (sourceOptions.noLoad) return;
            if (sourceOptions.error) {
                this.fire(new ErrorEvent(sourceOptions.error));
            } else {
                this.fire(new Event('data', {dataType: 'source', sourceDataType: 'metadata'}));
            }
        }
        abortTile() {}
        unloadTile() {}
        serialize() {}
    }
    const source = new SourceMock();

    return source;
}

setType('mock-source-type', MockSourceType);

function createSourceCache(options, used) {
    const spec = options || {};
    spec['minzoom'] = spec['minzoom'] || 0;
    spec['maxzoom'] = spec['maxzoom'] || 14;

    const eventedParent = new Evented();
    const sc = new SourceCache('id', create('id', extend({
        tileSize: 512,
        type: 'mock-source-type'
    }, spec), /* dispatcher */ {}, eventedParent));
    sc.used = typeof used === 'boolean' ? used : true;
    sc.transform = new Transform();
    sc.map = {painter: {transform: sc.transform}};
    return {sourceCache: sc, eventedParent};
}

test('SourceCache#addTile', (t) => {
    t.test('loads tile when uncached', (t) => {
        const tileID = new OverscaledTileID(0, 0, 0, 0, 0);
        const {sourceCache} = createSourceCache({
            loadTile(tile) {
                t.deepEqual(tile.tileID, tileID);
                t.equal(tile.uses, 0);
                t.end();
            }
        });
        sourceCache.onAdd();
        sourceCache._addTile(tileID);
    });

    t.test('adds tile when uncached', (t) => {
        const tileID = new OverscaledTileID(0, 0, 0, 0, 0);
        const {sourceCache, eventedParent} = createSourceCache({});
        eventedParent.on('dataloading', (data) => {
            t.deepEqual(data.tile.tileID, tileID);
            t.equal(data.tile.uses, 1);
            t.end();
        });
        sourceCache.onAdd();
        sourceCache._addTile(tileID);
    });

    t.test('updates feature state on added uncached tile', (t) => {
        const tileID = new OverscaledTileID(0, 0, 0, 0, 0);
        let updateFeaturesSpy;
        const {sourceCache, eventedParent} = createSourceCache({
            loadTile(tile, callback) {
                eventedParent.on('data', () => {
                    t.equal(updateFeaturesSpy.getCalls().length, 1);
                    t.end();
                });
                updateFeaturesSpy = t.spy(tile, 'setFeatureState');
                tile.state = 'loaded';
                callback();
            }
        });
        sourceCache.onAdd();
        sourceCache._addTile(tileID);
    });

    t.test('uses cached tile', (t) => {
        const tileID = new OverscaledTileID(0, 0, 0, 0, 0);
        let load = 0,
            add = 0;

        const {sourceCache, eventedParent} = createSourceCache({
            loadTile(tile, callback) {
                tile.state = 'loaded';
                load++;
                callback();
            }
        });
        eventedParent.on('dataloading', () => { add++; });

        const tr = new Transform();
        tr.width = 512;
        tr.height = 512;
        sourceCache.updateCacheSize(tr);
        sourceCache._addTile(tileID);
        sourceCache._removeTile(tileID.key);
        sourceCache._addTile(tileID);

        t.equal(load, 1);
        t.equal(add, 1);

        t.end();
    });

    t.test('updates feature state on cached tile', (t) => {
        const tileID = new OverscaledTileID(0, 0, 0, 0, 0);

        const {sourceCache} = createSourceCache({
            loadTile(tile, callback) {
                tile.state = 'loaded';
                callback();
            }
        });

        const tr = new Transform();
        tr.width = 512;
        tr.height = 512;
        sourceCache.updateCacheSize(tr);

        const tile = sourceCache._addTile(tileID);
        const updateFeaturesSpy = t.spy(tile, 'setFeatureState');

        sourceCache._removeTile(tileID.key);
        sourceCache._addTile(tileID);

        t.equal(updateFeaturesSpy.getCalls().length, 1);

        t.end();
    });

    t.test('moves timers when adding tile from cache', (t) => {
        const tileID = new OverscaledTileID(0, 0, 0, 0, 0);
        const time = new Date();
        time.setSeconds(time.getSeconds() + 5);

        const {sourceCache} = createSourceCache();
        sourceCache._setTileReloadTimer = (id) => {
            sourceCache._timers[id] = setTimeout(() => {}, 0);
        };
        sourceCache._loadTile = (tile, callback) => {
            tile.state = 'loaded';
            tile.getExpiryTimeout = () => 1000 * 60;
            sourceCache._setTileReloadTimer(tileID.key, tile);
            callback();
        };

        const tr = new Transform();
        tr.width = 512;
        tr.height = 512;
        sourceCache.updateCacheSize(tr);

        const id = tileID.key;
        t.notOk(sourceCache._timers[id]);
        t.notOk(sourceCache._cache.has(tileID));

        sourceCache._addTile(tileID);

        t.ok(sourceCache._timers[id]);
        t.notOk(sourceCache._cache.has(tileID));

        sourceCache._removeTile(tileID.key);

        t.notOk(sourceCache._timers[id]);
        t.ok(sourceCache._cache.has(tileID));

        sourceCache._addTile(tileID);

        t.ok(sourceCache._timers[id]);
        t.notOk(sourceCache._cache.has(tileID));

        t.end();
    });

    t.test('does not reuse wrapped tile', (t) => {
        const tileID = new OverscaledTileID(0, 0, 0, 0, 0);
        let load = 0,
            add = 0;

        const {sourceCache, eventedParent} = createSourceCache({
            loadTile(tile, callback) {
                tile.state = 'loaded';
                load++;
                callback();
            }
        });
        eventedParent.on('dataloading', () => { add++; });

        const t1 = sourceCache._addTile(tileID);
        const t2 = sourceCache._addTile(new OverscaledTileID(0, 1, 0, 0, 0));

        t.equal(load, 2);
        t.equal(add, 2);
        t.notEqual(t1, t2);

        t.end();
    });

    t.test('should load tiles with identical overscaled Z but different canonical Z', (t) => {
        const {sourceCache} = createSourceCache();

        const tileIDs = [
            new OverscaledTileID(1, 0, 0, 0, 0),
            new OverscaledTileID(1, 0, 1, 0, 0),
            new OverscaledTileID(1, 0, 1, 1, 0),
            new OverscaledTileID(1, 0, 1, 0, 1),
            new OverscaledTileID(1, 0, 1, 1, 1)
        ];

        for (let i = 0; i < tileIDs.length; i++)
            sourceCache._addTile(tileIDs[i]);

        for (let i = 0; i < tileIDs.length; i++) {
            const id = tileIDs[i];
            const key = id.key;

            t.ok(sourceCache._tiles[key]);
            t.deepEqual(sourceCache._tiles[key].tileID, id);
        }

        t.end();
    });

    t.end();
});

test('SourceCache#removeTile', (t) => {
    t.test('removes tile', (t) => {
        const tileID = new OverscaledTileID(0, 0, 0, 0, 0);
        const {sourceCache, eventedParent} = createSourceCache({});
        sourceCache._addTile(tileID);
        eventedParent.on('data', () => {
            sourceCache._removeTile(tileID.key);
            t.notOk(sourceCache._tiles[tileID.key]);
            t.end();
        });
    });

    t.test('caches (does not unload) loaded tile', (t) => {
        const tileID = new OverscaledTileID(0, 0, 0, 0, 0);
        const {sourceCache} = createSourceCache({
            loadTile(tile) {
                tile.state = 'loaded';
            },
            unloadTile() {
                t.fail();
            }
        });

        const tr = new Transform();
        tr.width = 512;
        tr.height = 512;
        sourceCache.updateCacheSize(tr);

        sourceCache._addTile(tileID);
        sourceCache._removeTile(tileID.key);

        t.end();
    });

    t.test('aborts and unloads unfinished tile', (t) => {
        const tileID = new OverscaledTileID(0, 0, 0, 0, 0);
        let abort = 0,
            unload = 0;

        const {sourceCache} = createSourceCache({
            abortTile(tile) {
                t.deepEqual(tile.tileID, tileID);
                abort++;
            },
            unloadTile(tile) {
                t.deepEqual(tile.tileID, tileID);
                unload++;
            }
        });

        sourceCache._addTile(tileID);
        sourceCache._removeTile(tileID.key);

        t.equal(abort, 1);
        t.equal(unload, 1);

        t.end();
    });

    t.test('_tileLoaded after _removeTile skips tile.added', (t) => {
        const tileID = new OverscaledTileID(0, 0, 0, 0, 0);

        const {sourceCache} = createSourceCache({
            loadTile(tile, callback) {
                tile.added = t.notOk();
                sourceCache._removeTile(tileID.key);
                callback();
            }
        });
        sourceCache.map = {painter: {transform: new Transform(), crossTileSymbolIndex: "", tileExtentVAO: {}, context: {
            createIndexBuffer: () => {},
            createVertexBuffer: () => {}
        }}};

        sourceCache._addTile(tileID);

        t.end();
    });

    t.end();
});

test('SourceCache / Source lifecycle', (t) => {
    t.test('does not fire load or change before source load event', (t) => {
        const {sourceCache, eventedParent} = createSourceCache({noLoad: true});
        eventedParent.on('data', t.fail);
        sourceCache.onAdd();
        setTimeout(t.end, 1);
    });

    t.test('forward load event', (t) => {
        const {sourceCache, eventedParent} = createSourceCache({});
        eventedParent.on('data', (e) => {
            if (e.sourceDataType === 'metadata') t.end();
        });
        sourceCache.getSource().onAdd();
    });

    t.test('forward change event', (t) => {
        const {sourceCache, eventedParent} = createSourceCache();
        eventedParent.on('data', (e) => {
            if (e.sourceDataType === 'metadata') t.end();
        });
        sourceCache.getSource().onAdd();
        sourceCache.getSource().fire(new Event('data'));
    });

    t.test('forward error event', (t) => {
        const {sourceCache, eventedParent} = createSourceCache({error: 'Error loading source'});
        eventedParent.on('error', (err) => {
            t.equal(err.error, 'Error loading source');
            t.end();
        });
        sourceCache.getSource().onAdd();
    });

    t.test('suppress 404 errors', (t) => {
        const {sourceCache, eventedParent} = createSourceCache({status: 404, message: 'Not found'});
        eventedParent.on('error', t.fail);
        sourceCache.getSource().onAdd();
        t.end();
    });

    t.test('loaded() true after source error', (t) => {
        const {sourceCache, eventedParent} = createSourceCache({error: 'Error loading source'});
        eventedParent.on('error', () => {
            t.ok(sourceCache.loaded());
            t.end();
        });
        sourceCache.getSource().onAdd();
    });

    t.test('loaded() true after tile error', (t) => {
        const transform = new Transform();
        transform.resize(511, 511);
        transform.zoom = 0;
        const {sourceCache, eventedParent} = createSourceCache({
            loadTile (tile, callback) {
                callback("error");
            }
        });
        eventedParent.on('data', (e) => {
            if (e.dataType === 'source' && e.sourceDataType === 'metadata') {
                sourceCache.update(transform);
            }
        }).on('error', () => {
            t.true(sourceCache.loaded());
            t.end();
        });

        sourceCache.getSource().onAdd();
    });

    t.test('reloads tiles after a data event where source is updated', (t) => {
        const transform = new Transform();
        transform.resize(511, 511);
        transform.zoom = 0;

        const expected = [ new OverscaledTileID(0, 0, 0, 0, 0).key, new OverscaledTileID(0, 0, 0, 0, 0).key ];
        t.plan(expected.length);

        const {sourceCache, eventedParent} = createSourceCache({
            loadTile (tile, callback) {
                t.equal(tile.tileID.key, expected.shift());
                tile.loaded = true;
                callback();
            }
        });

        eventedParent.on('data', (e) => {
            if (e.dataType === 'source' && e.sourceDataType === 'metadata') {
                sourceCache.update(transform);
                sourceCache.getSource().fire(new Event('data', {dataType: 'source', sourceDataType: 'content'}));
            }
        });

        sourceCache.getSource().onAdd();
    });

    t.test('does not reload errored tiles', (t) => {
        const transform = new Transform();
        transform.resize(511, 511);
        transform.zoom = 1;

        const {sourceCache, eventedParent} = createSourceCache({
            loadTile (tile, callback) {
                // this transform will try to load the four tiles at z1 and a single z0 tile
                // we only expect _reloadTile to be called with the 'loaded' z0 tile
                tile.state = tile.tileID.canonical.z === 1 ? 'errored' : 'loaded';
                callback();
            }
        });

        const reloadTileSpy = t.spy(sourceCache, '_reloadTile');
        eventedParent.on('data', (e) => {
            if (e.dataType === 'source' && e.sourceDataType === 'metadata') {
                sourceCache.update(transform);
                sourceCache.getSource().fire(new Event('data', {dataType: 'source', sourceDataType: 'content'}));
            }
        });
        sourceCache.getSource().onAdd();
        // we expect the source cache to have five tiles, but only to have reloaded one
        t.equal(Object.keys(sourceCache._tiles).length, 5);
        t.ok(reloadTileSpy.calledOnce);

        t.end();
    });

    t.end();
});

test('SourceCache#update', (t) => {
    t.test('loads no tiles if used is false', (t) => {
        const transform = new Transform();
        transform.resize(512, 512);
        transform.zoom = 0;

        const {sourceCache, eventedParent} = createSourceCache({}, false);
        eventedParent.on('data', (e) => {
            if (e.sourceDataType === 'metadata') {
                sourceCache.update(transform);
                t.deepEqual(sourceCache.getIds(), []);
                t.end();
            }
        });
        sourceCache.getSource().onAdd();
    });

    t.test('loads covering tiles', (t) => {
        const transform = new Transform();
        transform.resize(511, 511);
        transform.zoom = 0;

        const {sourceCache, eventedParent} = createSourceCache({});
        eventedParent.on('data', (e) => {
            if (e.sourceDataType === 'metadata') {
                sourceCache.update(transform);
                t.deepEqual(sourceCache.getIds(), [new OverscaledTileID(0, 0, 0, 0, 0).key]);
                t.end();
            }
        });
        sourceCache.getSource().onAdd();
    });

    t.test('respects Source#hasTile method if it is present', (t) => {
        const transform = new Transform();
        transform.resize(511, 511);
        transform.zoom = 1;

        const {sourceCache, eventedParent} = createSourceCache({
            hasTile: (coord) => (coord.canonical.x !== 0)
        });
        eventedParent.on('data', (e) => {
            if (e.sourceDataType === 'metadata') {
                sourceCache.update(transform);
                t.deepEqual(sourceCache.getIds().sort(), [
                    new OverscaledTileID(1, 0, 1, 1, 0).key,
                    new OverscaledTileID(1, 0, 1, 1, 1).key
                ].sort());
                t.end();
            }
        });
        sourceCache.getSource().onAdd();
    });

    t.test('removes unused tiles', (t) => {
        const transform = new Transform();
        transform.resize(511, 511);
        transform.zoom = 0;

        const {sourceCache, eventedParent} = createSourceCache({
            loadTile: (tile, callback) => {
                tile.state = 'loaded';
                callback(null);
            }
        });

        eventedParent.on('data', (e) => {
            if (e.sourceDataType === 'metadata') {
                sourceCache.update(transform);
                t.deepEqual(sourceCache.getIds(), [new OverscaledTileID(0, 0, 0, 0, 0).key]);

                transform.zoom = 1;
                sourceCache.update(transform);

                t.deepEqual(sourceCache.getIds(), [
                    new OverscaledTileID(1, 0, 1, 1, 1).key,
                    new OverscaledTileID(1, 0, 1, 0, 1).key,
                    new OverscaledTileID(1, 0, 1, 1, 0).key,
                    new OverscaledTileID(1, 0, 1, 0, 0).key
                ]);
                t.end();
            }
        });

        sourceCache.getSource().onAdd();
    });

    t.test('retains parent tiles for pending children', (t) => {
        const transform = new Transform();
        transform._test = 'retains';
        transform.resize(511, 511);
        transform.zoom = 0;

        const {sourceCache, eventedParent} = createSourceCache({
            loadTile(tile, callback) {
                tile.state = (tile.tileID.key === new OverscaledTileID(0, 0, 0, 0, 0).key) ? 'loaded' : 'loading';
                callback();
            }
        });

        eventedParent.on('data', (e) => {
            if (e.sourceDataType === 'metadata') {
                sourceCache.update(transform);
                t.deepEqual(sourceCache.getIds(), [new OverscaledTileID(0, 0, 0, 0, 0).key]);

                transform.zoom = 1;
                sourceCache.update(transform);

                t.deepEqual(sourceCache.getIds(), [
                    new OverscaledTileID(0, 0, 0, 0, 0).key,
                    new OverscaledTileID(1, 0, 1, 1, 1).key,
                    new OverscaledTileID(1, 0, 1, 0, 1).key,
                    new OverscaledTileID(1, 0, 1, 1, 0).key,
                    new OverscaledTileID(1, 0, 1, 0, 0).key
                ]);
                t.end();
            }
        });
        sourceCache.getSource().onAdd();
    });

    t.test('retains parent tiles for pending children (wrapped)', (t) => {
        const transform = new Transform();
        transform.resize(511, 511);
        transform.zoom = 0;
        transform.center = new LngLat(360, 0);

        const {sourceCache, eventedParent} = createSourceCache({
            loadTile(tile, callback) {
                tile.state = (tile.tileID.key === new OverscaledTileID(0, 1, 0, 0, 0).key) ? 'loaded' : 'loading';
                callback();
            }
        });

        eventedParent.on('data', (e) => {
            if (e.sourceDataType === 'metadata') {
                sourceCache.update(transform);
                t.deepEqual(sourceCache.getIds(), [new OverscaledTileID(0, 1, 0, 0, 0).key]);

                transform.zoom = 1;
                sourceCache.update(transform);

                t.deepEqual(sourceCache.getIds(), [
                    new OverscaledTileID(0, 1, 0, 0, 0).key,
                    new OverscaledTileID(1, 1, 1, 1, 1).key,
                    new OverscaledTileID(1, 1, 1, 0, 1).key,
                    new OverscaledTileID(1, 1, 1, 1, 0).key,
                    new OverscaledTileID(1, 1, 1, 0, 0).key
                ]);
                t.end();
            }
        });
        sourceCache.getSource().onAdd();
    });

    t.test('retains covered child tiles while parent tile is fading in', (t) => {
        const transform = new Transform();
        transform.resize(511, 511);
        transform.zoom = 2;

        const {sourceCache, eventedParent} = createSourceCache({
            loadTile(tile, callback) {
                tile.timeAdded = Infinity;
                tile.state = 'loaded';
                tile.registerFadeDuration(100);
                callback();
            }
        });

        sourceCache._source.type = 'raster';

        eventedParent.on('data', (e) => {
            if (e.sourceDataType === 'metadata') {
                sourceCache.update(transform);
                t.deepEqual(sourceCache.getIds(), [
                    new OverscaledTileID(2, 0, 2, 2, 2).key,
                    new OverscaledTileID(2, 0, 2, 1, 2).key,
                    new OverscaledTileID(2, 0, 2, 2, 1).key,
                    new OverscaledTileID(2, 0, 2, 1, 1).key
                ]);

                transform.zoom = 0;
                sourceCache.update(transform);

                t.deepEqual(sourceCache.getRenderableIds().length, 5);
                t.end();
            }
        });
        sourceCache.getSource().onAdd();
    });

    t.test('retains covered child tiles while parent tile is fading at high pitch', (t) => {
        const transform = new Transform();
        transform.resize(511, 511);
        transform.zoom = 16;
        transform.maxPitch = 85;
        transform.pitch = 85;
        transform.center = new LngLat(0, 0);

        const {sourceCache, eventedParent} = createSourceCache({
            loadTile(tile, callback) {
                tile.timeAdded = Infinity;
                tile.state = 'loaded';
                tile.registerFadeDuration(100);
                callback();
            }
        });

        sourceCache._source.type = 'raster';

        eventedParent.on('data', (e) => {
            if (e.sourceDataType === 'metadata') {
                sourceCache.update(transform);
                t.deepEqual(sourceCache.getIds(), [
                    new OverscaledTileID(13, 0, 13, 4096, 4094).key,
                    new OverscaledTileID(13, 0, 13, 4095, 4094).key,
                    new OverscaledTileID(14, 0, 14, 8192, 8192).key,
                    new OverscaledTileID(14, 0, 14, 8191, 8192).key,
                    new OverscaledTileID(14, 0, 14, 8192, 8191).key,
                    new OverscaledTileID(14, 0, 14, 8191, 8191).key,
                    new OverscaledTileID(14, 0, 14, 8192, 8190).key,
                    new OverscaledTileID(14, 0, 14, 8191, 8190).key
                ]);

                transform.center = new LngLat(0, -0.005);
                sourceCache.update(transform);

                t.deepEqual(sourceCache.getRenderableIds().length, 10);
                t.end();
            }
        });
        sourceCache.getSource().onAdd();
    });

    t.test('retains a parent tile for fading even if a tile is partially covered by children', (t) => {
        const transform = new Transform();
        transform.resize(511, 511);
        transform.zoom = 0;

        const {sourceCache, eventedParent} = createSourceCache({
            loadTile(tile, callback) {
                tile.timeAdded = Infinity;
                tile.state = 'loaded';
                tile.registerFadeDuration(100);
                callback();
            }
        });

        sourceCache._source.type = 'raster';

        eventedParent.on('data', (e) => {
            if (e.sourceDataType === 'metadata') {
                sourceCache.update(transform);

                transform.zoom = 2;
                sourceCache.update(transform);

                transform.zoom = 1;
                sourceCache.update(transform);

                t.equal(sourceCache._coveredTiles[(new OverscaledTileID(0, 0, 0, 0, 0).key)], true);
                t.end();
            }
        });
        sourceCache.getSource().onAdd();
    });

    t.test('retains children for fading when tile.fadeEndTime is not set', (t) => {
        const transform = new Transform();
        transform.resize(511, 511);
        transform.zoom = 1;

        const {sourceCache, eventedParent} = createSourceCache({
            loadTile(tile, callback) {
                tile.timeAdded = Date.now();
                tile.state = 'loaded';
                callback();
            }
        });

        sourceCache._source.type = 'raster';

        eventedParent.on('data', (e) => {
            if (e.sourceDataType === 'metadata') {
                sourceCache.update(transform);

                transform.zoom = 0;
                sourceCache.update(transform);

                t.equal(sourceCache.getRenderableIds().length, 5, 'retains 0/0/0 and its four children');
                t.end();
            }
        });
        sourceCache.getSource().onAdd();
    });

    t.test('retains children when tile.fadeEndTime is in the future', (t) => {
        const transform = new Transform();
        transform.resize(511, 511);
        transform.zoom = 1;

        const fadeTime = 100;

        const start = Date.now();
        let time = start;
        t.stub(browser, 'now').callsFake(() => time);

        const {sourceCache, eventedParent} = createSourceCache({
            loadTile(tile, callback) {
                tile.timeAdded = browser.now();
                tile.state = 'loaded';
                tile.fadeEndTime = browser.now() + fadeTime;
                callback();
            }
        });

        sourceCache._source.type = 'raster';

        eventedParent.on('data', (e) => {
            if (e.sourceDataType === 'metadata') {
                // load children
                sourceCache.update(transform);

                transform.zoom = 0;
                sourceCache.update(transform);

                t.equal(sourceCache.getRenderableIds().length, 5, 'retains 0/0/0 and its four children');

                time = start + 98;
                sourceCache.update(transform);
                t.equal(sourceCache.getRenderableIds().length, 5, 'retains 0/0/0 and its four children');

                time = start + fadeTime + 1;
                sourceCache.update(transform);
                t.equal(sourceCache.getRenderableIds().length, 1, 'drops children after fading is complete');
                t.end();
            }
        });

        sourceCache.getSource().onAdd();
    });

    t.test('retains overscaled loaded children', (t) => {
        const transform = new Transform();
        transform.resize(511, 511);
        transform.zoom = 16;

        // use slightly offset center so that sort order is better defined
        transform.center = new LngLat(-0.001, 0.001);

        const {sourceCache, eventedParent} = createSourceCache({
            reparseOverscaled: true,
            loadTile(tile, callback) {
                tile.state = tile.tileID.overscaledZ === 16 ? 'loaded' : 'loading';
                callback();
            }
        });

        eventedParent.on('data', (e) => {
            if (e.sourceDataType === 'metadata') {
                sourceCache.update(transform);
                t.deepEqual(sourceCache.getRenderableIds(), [
                    new OverscaledTileID(16, 0, 14, 8192, 8192).key,
                    new OverscaledTileID(16, 0, 14, 8191, 8192).key,
                    new OverscaledTileID(16, 0, 14, 8192, 8191).key,
                    new OverscaledTileID(16, 0, 14, 8191, 8191).key
                ]);

                transform.zoom = 15;
                sourceCache.update(transform);

                t.deepEqual(sourceCache.getRenderableIds(), [
                    new OverscaledTileID(16, 0, 14, 8192, 8192).key,
                    new OverscaledTileID(16, 0, 14, 8191, 8192).key,
                    new OverscaledTileID(16, 0, 14, 8192, 8191).key,
                    new OverscaledTileID(16, 0, 14, 8191, 8191).key
                ]);
                t.end();
            }
        });
        sourceCache.getSource().onAdd();
    });

    t.test('reassigns tiles for large jumps in longitude', (t) => {

        const transform = new Transform();
        transform.resize(511, 511);
        transform.zoom = 0;

        const {sourceCache, eventedParent} = createSourceCache({});
        eventedParent.on('data', (e) => {
            if (e.sourceDataType === 'metadata') {
                transform.center = new LngLat(360, 0);
                const tileID = new OverscaledTileID(0, 1, 0, 0, 0);
                sourceCache.update(transform);
                t.deepEqual(sourceCache.getIds(), [tileID.key]);
                const tile = sourceCache.getTile(tileID);

                transform.center = new LngLat(0, 0);
                const wrappedTileID = new OverscaledTileID(0, 0, 0, 0, 0);
                sourceCache.update(transform);
                t.deepEqual(sourceCache.getIds(), [wrappedTileID.key]);
                t.equal(sourceCache.getTile(wrappedTileID), tile);
                t.end();
            }
        });
        sourceCache.getSource().onAdd();
    });

    t.end();
});

test('SourceCache#_updateRetainedTiles', (t) => {

    t.test('loads ideal tiles if they exist', (t) => {
        const stateCache = {};
        const {sourceCache} = createSourceCache({
            loadTile(tile, callback) {
                tile.state = stateCache[tile.tileID.key] || 'errored';
                callback();
            }
        });

        const getTileSpy = t.spy(sourceCache, 'getTile');
        const idealTile = new OverscaledTileID(1, 0, 1, 1, 1);
        stateCache[idealTile.key] = 'loaded';
        sourceCache._updateRetainedTiles([idealTile]);
        t.ok(getTileSpy.notCalled);
        t.deepEqual(sourceCache.getIds(), [idealTile.key]);
        t.end();
    });

    t.test('retains all loaded children ', (t) => {
        const {sourceCache} = createSourceCache({
            loadTile(tile, callback) {
                tile.state = 'errored';
                callback();
            }
        });

        const idealTile = new OverscaledTileID(3, 0, 3, 1, 2);
        sourceCache._tiles[idealTile.key] = new Tile(idealTile);
        sourceCache._tiles[idealTile.key].state = 'errored';

        const loadedChildren = [
            new OverscaledTileID(4, 0, 4, 2, 4),
            new OverscaledTileID(4, 0, 4, 3, 4),
            new OverscaledTileID(4, 0, 4, 2, 5),
            new OverscaledTileID(5, 0, 5, 6, 10),
            new OverscaledTileID(5, 0, 5, 7, 10),
            new OverscaledTileID(5, 0, 5, 6, 11),
            new OverscaledTileID(5, 0, 5, 7, 11)
        ];

        for (const t of loadedChildren) {
            sourceCache._tiles[t.key] = new Tile(t);
            sourceCache._tiles[t.key].state = 'loaded';
        }

        const retained = sourceCache._updateRetainedTiles([idealTile]);
        t.deepEqual(Object.keys(retained).sort(), [
            // parents are requested because ideal ideal tile is not completely covered by
            // loaded child tiles
            new OverscaledTileID(0, 0, 0, 0, 0),
            new OverscaledTileID(2, 0, 2, 0, 1),
            new OverscaledTileID(1, 0, 1, 0, 0),
            idealTile
        ].concat(loadedChildren).map(t => t.key).sort());

        t.end();
    });

    t.test('retains children for LOD cover', (t) => {
        const {sourceCache} = createSourceCache({
            minzoom: 2,
            maxzoom: 5,
            loadTile(tile, callback) {
                tile.state = 'errored';
                callback();
            }
        });

        const idealTiles = [
            new OverscaledTileID(5, 1, 5, 7, 10),
            new OverscaledTileID(4, 2, 4, 2, 4),
            new OverscaledTileID(3, 0, 3, 1, 2)
        ];
        for (const t of idealTiles) {
            sourceCache._tiles[t.key] = new Tile(t);
            sourceCache._tiles[t.key].state = 'errored';
        }

        const loadedChildren = [
            // Children of OverscaledTileID(3, 0, 3, 1, 2)
            new OverscaledTileID(4, 0, 4, 2, 4),
            new OverscaledTileID(4, 0, 4, 3, 4),
            new OverscaledTileID(4, 0, 4, 2, 5),
            new OverscaledTileID(5, 0, 5, 6, 10),
            new OverscaledTileID(5, 0, 5, 7, 10),
            new OverscaledTileID(5, 0, 5, 6, 11),
            new OverscaledTileID(5, 0, 5, 7, 11),

            // Children of OverscaledTileID(4, 2, 4, 2, 4). Overscale (not canonical.z) over maxzoom.
            new OverscaledTileID(5, 2, 5, 4, 8),
            new OverscaledTileID(5, 2, 5, 5, 8),
            new OverscaledTileID(6, 2, 5, 4, 9),
            new OverscaledTileID(9, 2, 5, 5, 9), // over maxUnderzooming.

            // Children over maxzoom and parent of new OverscaledTileID(5, 1, 5, 7, 10)
            new OverscaledTileID(6, 1, 6, 14, 20),
            new OverscaledTileID(6, 1, 6, 15, 20),
            new OverscaledTileID(6, 1, 6, 14, 21),
            new OverscaledTileID(6, 1, 6, 15, 21),
            new OverscaledTileID(4, 1, 4, 3, 5)
        ];

        for (const t of loadedChildren) {
            sourceCache._tiles[t.key] = new Tile(t);
            sourceCache._tiles[t.key].state = 'loaded';
        }

        const retained = sourceCache._updateRetainedTiles(idealTiles);

        // Filter out those that are not supposed to be retained:
        const filteredChildren = loadedChildren.filter(t => {
            return ![
                new OverscaledTileID(6, 1, 6, 14, 20),
                new OverscaledTileID(6, 1, 6, 15, 20),
                new OverscaledTileID(6, 1, 6, 14, 21),
                new OverscaledTileID(6, 1, 6, 15, 21),
                new OverscaledTileID(9, 2, 5, 5, 9)
            ].map(t => t.key).includes(t.key);
        });

        t.deepEqual(Object.keys(retained).sort(), [
            // parents are requested up to minzoom because ideal tiles are not
            // completely covered by loaded child tiles
            new OverscaledTileID(2, 0, 2, 0, 1),
            new OverscaledTileID(2, 2, 2, 0, 1),
            new OverscaledTileID(3, 2, 3, 1, 2)
        ].concat(idealTiles).concat(filteredChildren).map(t => t.key).sort());

        t.end();
    });

    t.test('adds parent tile if ideal tile errors and no child tiles are loaded', (t) => {
        const stateCache = {};
        const {sourceCache} = createSourceCache({
            loadTile(tile, callback) {
                tile.state = stateCache[tile.tileID.key] || 'errored';
                callback();
            }
        });

        const addTileSpy = t.spy(sourceCache, '_addTile');
        const getTileSpy = t.spy(sourceCache, 'getTile');

        const idealTiles = [new OverscaledTileID(1, 0, 1, 1, 1), new OverscaledTileID(1, 0, 1, 0, 1)];
        stateCache[idealTiles[0].key] = 'loaded';
        const retained = sourceCache._updateRetainedTiles(idealTiles);
        t.deepEqual(getTileSpy.getCalls().map((c) => { return c.args[0]; }), [
            // when child tiles aren't found, check and request parent tile
            new OverscaledTileID(0, 0, 0, 0, 0)
        ]);

        // retained tiles include all ideal tiles and any parents that were loaded to cover
        // non-existant tiles
        t.deepEqual(retained, {
            // 1/0/1
            '1040': new OverscaledTileID(1, 0, 1, 0, 1),
            // 1/1/1
            '1552': new OverscaledTileID(1, 0, 1, 1, 1),
            // parent
            '0': new OverscaledTileID(0, 0, 0, 0, 0)
        });
        addTileSpy.restore();
        getTileSpy.restore();
        t.end();
    });

    t.test('don\'t use wrong parent tile', (t) => {
        const {sourceCache} = createSourceCache({
            loadTile(tile, callback) {
                tile.state = 'errored';
                callback();
            }
        });

        const idealTile = new OverscaledTileID(2, 0, 2, 0, 0);
        sourceCache._tiles[idealTile.key] = new Tile(idealTile);
        sourceCache._tiles[idealTile.key].state = 'errored';

        sourceCache._tiles[new OverscaledTileID(1, 0, 1, 1, 0).key] = new Tile(new OverscaledTileID(1, 0, 1, 1, 0));
        sourceCache._tiles[new OverscaledTileID(1, 0, 1, 1, 0).key].state = 'loaded';

        const addTileSpy = t.spy(sourceCache, '_addTile');
        const getTileSpy = t.spy(sourceCache, 'getTile');

        sourceCache._updateRetainedTiles([idealTile]);
        t.deepEqual(getTileSpy.getCalls().map((c) => { return c.args[0]; }), [
            // parents
            new OverscaledTileID(1, 0, 1, 0, 0), // not found
            new OverscaledTileID(0, 0, 0, 0, 0)  // not found
        ]);

        t.deepEqual(addTileSpy.getCalls().map((c) => { return c.args[0]; }), [
            // ideal tile
            new OverscaledTileID(2, 0, 2, 0, 0),
            // parents
            new OverscaledTileID(1, 0, 1, 0, 0), // not found
            new OverscaledTileID(0, 0, 0, 0, 0)  // not found
        ]);

        addTileSpy.restore();
        getTileSpy.restore();
        t.end();
    });

    t.test('use parent tile when ideal tile is not loaded', (t) => {
        const {sourceCache} = createSourceCache({
            loadTile(tile, callback) {
                tile.state = 'loading';
                callback();
            }
        });
        const idealTile = new OverscaledTileID(1, 0, 1, 0, 1);
        const parentTile = new OverscaledTileID(0, 0, 0, 0, 0);
        sourceCache._tiles[idealTile.key] = new Tile(idealTile);
        sourceCache._tiles[idealTile.key].state = 'loading';
        sourceCache._tiles[parentTile.key] = new Tile(parentTile);
        sourceCache._tiles[parentTile.key].state = 'loaded';

        const addTileSpy = t.spy(sourceCache, '_addTile');
        const getTileSpy = t.spy(sourceCache, 'getTile');

        const retained = sourceCache._updateRetainedTiles([idealTile]);

        t.deepEqual(getTileSpy.getCalls().map((c) => { return c.args[0]; }), [
            // parents
            new OverscaledTileID(0, 0, 0, 0, 0), // found
        ]);

        t.deepEqual(retained, {
            // parent of ideal tile 0/0/0
            '0' : new OverscaledTileID(0, 0, 0, 0, 0),
            // ideal tile id 1/0/1
            '1040' : new OverscaledTileID(1, 0, 1, 0, 1)
        }, 'retain ideal and parent tile when ideal tiles aren\'t loaded');

        addTileSpy.resetHistory();
        getTileSpy.resetHistory();

        // now make sure we don't retain the parent tile when the ideal tile is loaded
        sourceCache._tiles[idealTile.key].state = 'loaded';
        const retainedLoaded = sourceCache._updateRetainedTiles([idealTile]);

        t.ok(getTileSpy.notCalled);
        t.deepEqual(retainedLoaded, {
            // only ideal tile retained
            '1040' : new OverscaledTileID(1, 0, 1, 0, 1)
        }, 'only retain ideal tiles when they\'re all loaded');

        addTileSpy.restore();
        getTileSpy.restore();

        t.end();
    });

    t.test('don\'t load parent if all immediate children are loaded', (t) => {
        const {sourceCache} = createSourceCache({
            loadTile(tile, callback) {
                tile.state = 'loading';
                callback();
            }
        });

        const idealTile = new OverscaledTileID(2, 0, 2, 1, 1);
        const loadedTiles = [new OverscaledTileID(3, 0, 3, 2, 2), new OverscaledTileID(3, 0, 3, 3, 2), new OverscaledTileID(3, 0, 3, 2, 3), new OverscaledTileID(3, 0, 3, 3, 3)];
        loadedTiles.forEach((t) => {
            sourceCache._tiles[t.key] = new Tile(t);
            sourceCache._tiles[t.key].state = 'loaded';
        });

        const getTileSpy = t.spy(sourceCache, 'getTile');
        const retained = sourceCache._updateRetainedTiles([idealTile]);
        // parent tile isn't requested because all covering children are loaded
        t.deepEqual(getTileSpy.getCalls(), []);
        t.deepEqual(Object.keys(retained), [idealTile.key].concat(loadedTiles.map(t => t.key)));
        t.end();

    });

    t.test('prefer loaded child tiles to parent tiles', (t) => {
        const {sourceCache} = createSourceCache({
            loadTile(tile, callback) {
                tile.state = 'loading';
                callback();
            }
        });
        const idealTile = new OverscaledTileID(1, 0, 1, 0, 0);
        const loadedTiles = [new OverscaledTileID(0, 0, 0, 0, 0), new OverscaledTileID(2, 0, 2, 0, 0)];
        loadedTiles.forEach((t) => {
            sourceCache._tiles[t.key] = new Tile(t);
            sourceCache._tiles[t.key].state = 'loaded';
        });

        const getTileSpy = t.spy(sourceCache, 'getTile');
        let retained = sourceCache._updateRetainedTiles([idealTile]);
        t.deepEqual(getTileSpy.getCalls().map((c) => { return c.args[0]; }), [
            // parent
            new OverscaledTileID(0, 0, 0, 0, 0)
        ]);

        t.deepEqual(retained, {
            // parent of ideal tile (0, 0, 0) (only partially covered by loaded child
            // tiles, so we still need to load the parent)
            '0' : new OverscaledTileID(0, 0, 0, 0, 0),
            // ideal tile id (1, 0, 0)
            '16' : new OverscaledTileID(1, 0, 1, 0, 0),
            // loaded child tile (2, 0, 0)
            '32': new OverscaledTileID(2, 0, 2, 0, 0)
        }, 'retains children and parent when ideal tile is partially covered by a loaded child tile');

        getTileSpy.restore();
        // remove child tile and check that it only uses parent tile
        delete sourceCache._tiles['32'];
        retained = sourceCache._updateRetainedTiles([idealTile]);

        t.deepEqual(retained, {
            // parent of ideal tile (0, 0, 0) (only partially covered by loaded child
            // tiles, so we still need to load the parent)
            '0' : new OverscaledTileID(0, 0, 0, 0, 0),
            // ideal tile id (1, 0, 0)
            '16' : new OverscaledTileID(1, 0, 1, 0, 0)
        }, 'only retains parent tile if no child tiles are loaded');

        t.end();
    });

    t.test('don\'t use tiles below minzoom', (t) => {
        const {sourceCache} = createSourceCache({
            loadTile(tile, callback) {
                tile.state = 'loading';
                callback();
            },
            minzoom: 2
        });
        const idealTile = new OverscaledTileID(2, 0, 2, 0, 0);
        const loadedTiles = [new OverscaledTileID(1, 0, 1, 0, 0)];
        loadedTiles.forEach((t) => {
            sourceCache._tiles[t.key] = new Tile(t);
            sourceCache._tiles[t.key].state = 'loaded';
        });

        const getTileSpy = t.spy(sourceCache, 'getTile');
        const retained = sourceCache._updateRetainedTiles([idealTile]);

        t.deepEqual(getTileSpy.getCalls().map((c) => { return c.args[0]; }), [], 'doesn\'t request parent tiles bc they are lower than minzoom');

        t.deepEqual(retained, {
            // ideal tile id (2, 0, 0)
            '32' : new OverscaledTileID(2, 0, 2, 0, 0)
        }, 'doesn\'t retain parent tiles below minzoom');

        getTileSpy.restore();
        t.end();
    });

    t.test('use overzoomed tile above maxzoom', (t) => {
        const {sourceCache} = createSourceCache({
            loadTile(tile, callback) {
                tile.state = 'loading';
                callback();
            },
            maxzoom: 2
        });
        const idealTile = new OverscaledTileID(2, 0, 2, 0, 0);

        const getTileSpy = t.spy(sourceCache, 'getTile');
        const retained = sourceCache._updateRetainedTiles([idealTile]);

        t.deepEqual(getTileSpy.getCalls().map((c) => { return c.args[0]; }), [
            // overzoomed child
            new OverscaledTileID(3, 0, 2, 0, 0),
            // parents
            new OverscaledTileID(1, 0, 1, 0, 0),
            new OverscaledTileID(0, 0, 0, 0, 0)
        ], 'doesn\'t request childtiles above maxzoom');

        t.deepEqual(retained, {
            // ideal tile id (2, 0, 0)
            '32' : new OverscaledTileID(2, 0, 2, 0, 0)
        }, 'doesn\'t retain child tiles above maxzoom');

        getTileSpy.restore();
        t.end();
    });

    t.test('dont\'t ascend multiple times if a tile is not found', (t) => {
        const {sourceCache} = createSourceCache({
            loadTile(tile, callback) {
                tile.state = 'loading';
                callback();
            }
        });
        const idealTiles = [new OverscaledTileID(8, 0, 8, 0, 0), new OverscaledTileID(8, 0, 8, 1, 0)];

        const getTileSpy = t.spy(sourceCache, 'getTile');
        sourceCache._updateRetainedTiles(idealTiles);
        t.deepEqual(getTileSpy.getCalls().map((c) => { return c.args[0]; }), [
            // parent tile ascent
            new OverscaledTileID(7, 0, 7, 0, 0),
            new OverscaledTileID(6, 0, 6, 0, 0),
            new OverscaledTileID(5, 0, 5, 0, 0),
            new OverscaledTileID(4, 0, 4, 0, 0),
            new OverscaledTileID(3, 0, 3, 0, 0),
            new OverscaledTileID(2, 0, 2, 0, 0),
            new OverscaledTileID(1, 0, 1, 0, 0),
            new OverscaledTileID(0, 0, 0, 0, 0),
        ], 'only ascends up a tile pyramid once');

        getTileSpy.resetHistory();

        const loadedTiles = [new OverscaledTileID(4, 0, 4, 0, 0)];
        loadedTiles.forEach((t) => {
            sourceCache._tiles[t.key] = new Tile(t);
            sourceCache._tiles[t.key].state = 'loaded';
        });

        sourceCache._updateRetainedTiles(idealTiles);
        t.deepEqual(getTileSpy.getCalls().map((c) => { return c.args[0]; }), [
            // parent tile ascent
            new OverscaledTileID(7, 0, 7, 0, 0),
            new OverscaledTileID(6, 0, 6, 0, 0),
            new OverscaledTileID(5, 0, 5, 0, 0),
            new OverscaledTileID(4, 0, 4, 0, 0), // tile is loaded, stops ascent
        ], 'ascent stops if a loaded parent tile is found');

        getTileSpy.restore();
        t.end();
    });

    t.test('adds correct leaded parent tiles for overzoomed tiles', (t) => {
        const {sourceCache} = createSourceCache({
            loadTile(tile, callback) {
                tile.state = 'loading';
                callback();
            },
            maxzoom: 7
        });
        const loadedTiles = [new OverscaledTileID(7, 0, 7, 0, 0), new OverscaledTileID(7, 0, 7, 1, 0)];
        loadedTiles.forEach((t) => {
            sourceCache._tiles[t.key] = new Tile(t);
            sourceCache._tiles[t.key].state = 'loaded';
        });

        const idealTiles = [new OverscaledTileID(8, 0, 7, 0, 0), new OverscaledTileID(8, 0, 7, 1, 0)];
        const retained = sourceCache._updateRetainedTiles(idealTiles);

        t.deepEqual(Uint32Array.from(Object.keys(retained)).sort(), Uint32Array.from([
            new OverscaledTileID(7, 0, 7, 1, 0).key,
            new OverscaledTileID(8, 0, 7, 1, 0).key,
            new OverscaledTileID(8, 0, 7, 0, 0).key,
            new OverscaledTileID(7, 0, 7, 0, 0).key
        ]).sort());

        t.end();
    });

    t.end();
});

test('SourceCache#clearTiles', (t) => {
    t.test('unloads tiles', (t) => {
        const coord = new OverscaledTileID(0, 0, 0, 0, 0);
        let abort = 0,
            unload = 0;

        const {sourceCache} = createSourceCache({
            abortTile(tile) {
                t.deepEqual(tile.tileID, coord);
                abort++;
            },
            unloadTile(tile) {
                t.deepEqual(tile.tileID, coord);
                unload++;
            }
        });
        sourceCache.onAdd();

        sourceCache._addTile(coord);
        sourceCache.clearTiles();

        t.equal(abort, 1);
        t.equal(unload, 1);

        t.end();
    });

    t.end();
});

test('SourceCache#tilesIn', (t) => {
    t.test('graceful response before source loaded', (t) => {
        const tr = new Transform();
        tr.width = 512;
        tr.height = 512;
        tr._calcMatrices();
        const {sourceCache} = createSourceCache({noLoad: true});
        sourceCache.transform = tr;
        sourceCache.onAdd();
        const queryGeometry = QueryGeometry.createFromScreenPoints([new Point(0, 0), new Point(512, 256)], tr);
        t.same(sourceCache.tilesIn(queryGeometry), []);

        t.end();
    });

    function round(queryGeometry) {
        return {
            min: queryGeometry.min.round(),
            max: queryGeometry.max.round()
        };
    }

    t.test('regular tiles', (t) => {
        const transform = new Transform();
        transform.resize(512, 512);
        transform.zoom = 1;
        transform.center = new LngLat(0, 1);

        const {sourceCache, eventedParent} = createSourceCache({
            loadTile(tile, callback) {
                tile.state = 'loaded';
                tile.additionalRadius = 0;
                callback();
            }
        });

        eventedParent.on('data', (e) => {
            if (e.sourceDataType === 'metadata') {
                sourceCache.update(transform);

                t.deepEqual(sourceCache.getIds(), [
                    new OverscaledTileID(1, 0, 1, 1, 1).key,
                    new OverscaledTileID(1, 0, 1, 0, 1).key,
                    new OverscaledTileID(1, 0, 1, 1, 0).key,
                    new OverscaledTileID(1, 0, 1, 0, 0).key
                ]);

                transform._calcMatrices();
                const queryGeometry = QueryGeometry.createFromScreenPoints([new Point(0, 0), new Point(512, 256)], transform);
                const tiles = sourceCache.tilesIn(queryGeometry, false, false);

                tiles.sort((a, b) => { return a.tile.tileID.canonical.x - b.tile.tileID.canonical.x; });
                tiles.forEach((result) => { delete result.tile.uid; });

                t.equal(tiles[0].tile.tileID.key, 16);
                t.equal(tiles[0].tile.tileSize, 512);
                t.deepEqual(round(tiles[0].bufferedTilespaceBounds), {min: {x: 4080, y: 4034}, max: {x:8192, y: 8162}});

                t.equal(tiles[1].tile.tileID.key, 528);
                t.equal(tiles[1].tile.tileSize, 512);
                t.deepEqual(round(tiles[1].bufferedTilespaceBounds), {min: {x: 0, y: 4034}, max: {x: 4112, y: 8162}});

                t.end();
            }
        });
        sourceCache.getSource().onAdd();
    });

    t.test('reparsed overscaled tiles', (t) => {
        const {sourceCache, eventedParent} = createSourceCache({
            loadTile(tile, callback) {
                tile.state = 'loaded';
                tile.additionalRadius = 0;
                callback();
            },
            reparseOverscaled: true,
            minzoom: 1,
            maxzoom: 1,
            tileSize: 512
        });

        eventedParent.on('data', (e) => {
            if (e.sourceDataType === 'metadata') {
                const transform = new Transform();
                transform.resize(1024, 1024);
                transform.zoom = 2.0;
                transform.center = new LngLat(0, 1);
                sourceCache.update(transform);

                t.deepEqual(sourceCache.getIds(), [
                    new OverscaledTileID(2, 0, 1, 1, 1).key,
                    new OverscaledTileID(2, 0, 1, 0, 1).key,
                    new OverscaledTileID(2, 0, 1, 1, 0).key,
                    new OverscaledTileID(2, 0, 1, 0, 0).key
                ]);

                const queryGeometry = QueryGeometry.createFromScreenPoints([new Point(0, 0), new Point(1024, 512)], transform);

                const tiles = sourceCache.tilesIn(queryGeometry);

                tiles.sort((a, b) => { return a.tile.tileID.canonical.x - b.tile.tileID.canonical.x; });
                tiles.forEach((result) => { delete result.tile.uid; });

                t.equal(tiles[0].tile.tileID.key, 17);
                t.equal(tiles[0].tile.tileSize, 1024);
                t.deepEqual(round(tiles[0].bufferedTilespaceBounds), {min: {x: 4088, y: 4042}, max: {x:8192, y: 8154}});

                t.equal(tiles[1].tile.tileID.key, 529);
                t.equal(tiles[1].tile.tileSize, 1024);
                t.deepEqual(round(tiles[1].bufferedTilespaceBounds), {min: {x: 0, y: 4042}, max: {x: 4104, y: 8154}});

                t.end();
            }
        });
        sourceCache.getSource().onAdd();
    });

    t.test('overscaled tiles', (t) => {
        const {sourceCache, eventedParent} = createSourceCache({
            loadTile(tile, callback) { tile.state = 'loaded'; callback(); },
            reparseOverscaled: false,
            minzoom: 1,
            maxzoom: 1,
            tileSize: 512
        });

        eventedParent.on('data', (e) => {
            if (e.sourceDataType === 'metadata') {
                const transform = new Transform();
                transform.resize(512, 512);
                transform.zoom = 2.0;
                sourceCache.update(transform);

                t.end();
            }
        });
        sourceCache.getSource().onAdd();
    });

    t.end();
});

test('SourceCache#loaded (no errors)', (t) => {
    const {sourceCache, eventedParent} = createSourceCache({
        loadTile(tile, callback) {
            tile.state = 'loaded';
            callback();
        }
    });

    eventedParent.on('data', (e) => {
        if (e.sourceDataType === 'metadata') {
            const coord = new OverscaledTileID(0, 0, 0, 0, 0);
            sourceCache._addTile(coord);

            t.ok(sourceCache.loaded());
            t.end();
        }
    });
    sourceCache.getSource().onAdd();
});

test('SourceCache#loaded (with errors)', (t) => {
    const {sourceCache, eventedParent} = createSourceCache({
        loadTile(tile) {
            tile.state = 'errored';
        }
    });

    eventedParent.on('data', (e) => {
        if (e.sourceDataType === 'metadata') {
            const coord = new OverscaledTileID(0, 0, 0, 0, 0);
            sourceCache._addTile(coord);

            t.ok(sourceCache.loaded());
            t.end();
        }
    });
    sourceCache.getSource().onAdd();
});

test('SourceCache#getIds (ascending order by zoom level)', (t) => {
    const ids = [
        new OverscaledTileID(0, 0, 0, 0, 0),
        new OverscaledTileID(3, 0, 3, 0, 0),
        new OverscaledTileID(1, 0, 1, 0, 0),
        new OverscaledTileID(2, 0, 2, 0, 0)
    ];

    const {sourceCache} = createSourceCache({});
    sourceCache.transform = new Transform();
    for (let i = 0; i < ids.length; i++) {
        sourceCache._tiles[ids[i].key] = {tileID: ids[i]};
    }
    t.deepEqual(sourceCache.getIds(), [
        new OverscaledTileID(0, 0, 0, 0, 0).key,
        new OverscaledTileID(1, 0, 1, 0, 0).key,
        new OverscaledTileID(2, 0, 2, 0, 0).key,
        new OverscaledTileID(3, 0, 3, 0, 0).key
    ]);
    t.end();
    sourceCache.onAdd();
});

test('SourceCache#findLoadedParent', (t) => {

    t.test('adds from previously used tiles (sourceCache._tiles)', (t) => {
        const {sourceCache} = createSourceCache({});
        sourceCache.onAdd();
        const tr = new Transform();
        tr.width = 512;
        tr.height = 512;
        sourceCache.updateCacheSize(tr);

        const tile = {
            tileID: new OverscaledTileID(1, 0, 1, 0, 0),
            hasData() { return true; }
        };

        sourceCache._tiles[tile.tileID.key] = tile;

        t.equal(sourceCache.findLoadedParent(new OverscaledTileID(2, 0, 2, 3, 3), 0), undefined);
        t.deepEqual(sourceCache.findLoadedParent(new OverscaledTileID(2, 0, 2, 0, 0), 0), tile);
        t.end();
    });

    t.test('retains parents', (t) => {
        const {sourceCache} = createSourceCache({});
        sourceCache.onAdd();
        const tr = new Transform();
        tr.width = 512;
        tr.height = 512;
        sourceCache.updateCacheSize(tr);

        const tile = new Tile(new OverscaledTileID(1, 0, 1, 0, 0), 512, 22);
        sourceCache._cache.add(tile.tileID, tile);

        t.equal(sourceCache.findLoadedParent(new OverscaledTileID(2, 0, 2, 3, 3), 0), undefined);
        t.equal(sourceCache.findLoadedParent(new OverscaledTileID(2, 0, 2, 0, 0), 0), tile);
        t.equal(sourceCache._cache.order.length, 1);

        t.end();
    });

    t.test('Search cache for loaded parent tiles', (t) => {
        const {sourceCache} = createSourceCache({});
        sourceCache.onAdd();
        const tr = new Transform();
        tr.width = 512;
        tr.height = 512;
        sourceCache.updateCacheSize(tr);

        const mockTile = id => {
            const tile = {
                tileID: id,
                hasData() { return true; }
            };
            sourceCache._tiles[id.key] = tile;
        };

        const tiles = [
            new OverscaledTileID(0, 0, 0, 0, 0),
            new OverscaledTileID(1, 0, 1, 1, 0),
            new OverscaledTileID(2, 0, 2, 0, 0),
            new OverscaledTileID(2, 0, 2, 1, 0),
            new OverscaledTileID(2, 0, 2, 2, 0),
            new OverscaledTileID(2, 0, 2, 1, 2)
        ];

        tiles.forEach(t => mockTile(t));
        sourceCache._updateLoadedParentTileCache();

        // Loaded tiles excluding the root should be in the cache
        t.equal(sourceCache.findLoadedParent(tiles[0], 0), undefined);
        t.equal(sourceCache.findLoadedParent(tiles[1], 0).tileID, tiles[0]);
        t.equal(sourceCache.findLoadedParent(tiles[2], 0).tileID, tiles[0]);
        t.equal(sourceCache.findLoadedParent(tiles[3], 0).tileID, tiles[0]);
        t.equal(sourceCache.findLoadedParent(tiles[4], 0).tileID, tiles[1]);
        t.equal(sourceCache.findLoadedParent(tiles[5], 0).tileID, tiles[0]);

        t.equal(tiles[0].key in sourceCache._loadedParentTiles, false);
        t.equal(tiles[1].key in sourceCache._loadedParentTiles, true);
        t.equal(tiles[2].key in sourceCache._loadedParentTiles, true);
        t.equal(tiles[3].key in sourceCache._loadedParentTiles, true);
        t.equal(tiles[4].key in sourceCache._loadedParentTiles, true);
        t.equal(tiles[5].key in sourceCache._loadedParentTiles, true);

        // Arbitray tiles should not in the cache
        const notLoadedTiles = [
            new OverscaledTileID(2, 1, 2, 0, 0),
            new OverscaledTileID(2, 0, 2, 3, 0),
            new OverscaledTileID(2, 0, 2, 3, 3),
            new OverscaledTileID(3, 0, 3, 2, 1)
        ];

        t.equal(sourceCache.findLoadedParent(notLoadedTiles[0], 0), undefined);
        t.equal(sourceCache.findLoadedParent(notLoadedTiles[1], 0).tileID, tiles[1]);
        t.equal(sourceCache.findLoadedParent(notLoadedTiles[2], 0).tileID, tiles[0]);
        t.equal(sourceCache.findLoadedParent(notLoadedTiles[3], 0).tileID, tiles[3]);

        t.equal(notLoadedTiles[0].key in sourceCache._loadedParentTiles, false);
        t.equal(notLoadedTiles[1].key in sourceCache._loadedParentTiles, false);
        t.equal(notLoadedTiles[2].key in sourceCache._loadedParentTiles, false);
        t.equal(notLoadedTiles[3].key in sourceCache._loadedParentTiles, false);

        t.end();
    });

    t.end();
});

test('SourceCache#reload', (t) => {
    t.test('before loaded', (t) => {
        const {sourceCache} = createSourceCache({noLoad: true});
        sourceCache.onAdd();

        t.doesNotThrow(() => {
            sourceCache.reload();
        }, null, 'reload ignored gracefully');

        t.end();
    });

    t.end();
});

test('SourceCache reloads expiring tiles', (t) => {
    t.test('calls reloadTile when tile expires', (t) => {
        const coord = new OverscaledTileID(1, 0, 1, 0, 1, 0, 0);

        const expiryDate = new Date();
        expiryDate.setMilliseconds(expiryDate.getMilliseconds() + 50);
        const {sourceCache} = createSourceCache({expires: expiryDate});

        sourceCache._reloadTile = (id, state) => {
            t.equal(state, 'expired');
            t.end();
        };

        sourceCache._addTile(coord);
    });

    t.end();
});

test('SourceCache sets max cache size correctly', (t) => {
    t.test('sets cache size based on 256 tiles', (t) => {
        const {sourceCache} = createSourceCache({
            tileSize: 256
        });

        const tr = new Transform();
        tr.width = 512;
        tr.height = 512;
        sourceCache.updateCacheSize(tr);

        // Expect max size to be ((512 / tileSize + 1) ^ 2) * 5 => 3 * 3 * 5
        t.equal(sourceCache._cache.max, 45);
        t.end();
    });

    t.test('sets cache size given optional tileSize', (t) => {
        const {sourceCache} = createSourceCache({
            tileSize: 256
        });

        const tr = new Transform();
        tr.width = 512;
        tr.height = 512;
        sourceCache.updateCacheSize(tr, 2048);

        // Expect max size to be ((512 / tileSize + 1) ^ 2) * 5 => 3 * 3 * 5
        t.equal(sourceCache._cache.max, 20);
        t.end();
    });

    t.test('sets cache size based on 512 tiles', (t) => {
        const {sourceCache} = createSourceCache({
            tileSize: 512
        });

        const tr = new Transform();
        tr.width = 512;
        tr.height = 512;
        sourceCache.updateCacheSize(tr);

        // Expect max size to be ((512 / tileSize + 1) ^ 2) * 5 => 2 * 2 * 5
        t.equal(sourceCache._cache.max, 20);
        t.end();
    });

    t.end();
});

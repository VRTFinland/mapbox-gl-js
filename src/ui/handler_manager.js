// @flow

import {MapMouseEvent, MapTouchEvent, MapWheelEvent} from '../ui/events';
import {Event} from '../util/evented';
import DOM from '../util/dom';
import browser from '../util/browser';
import type Map from './map';
import Handler from './handler/handler';
//import { TouchPanHandler, TouchZoomHandler, TouchRotateHandler, TouchPitchHandler } from './handler/touch';
import MousePanHandler from './handler/mouse_pan';
import MousePitchHandler from './handler/mouse_pitch';
import MouseRotateHandler from './handler/mouse_rotate';
import TouchPanHandler from './handler/touch_pan';
import TouchZoomHandler from './handler/touch_zoom';
import TouchRotateHandler from './handler/touch_rotate';
import TouchPitchHandler from './handler/touch_pitch';
import KeyboardHandler from './handler/keyboard';
import { log } from './handler/handler_util';
import {bezier, extend} from '../util/util';
import Point from '@mapbox/point-geometry';
import assert from 'assert';

const defaultInertiaOptions = {
    linearity: 0.15,
    easing: bezier(0, 0, 0.15, 1),
    deceleration: 3,
    maxSpeed: 1.5
};
export type InertiaOptions = typeof defaultInertiaOptions;

export type InputEvent = MouseEvent | TouchEvent | KeyboardEvent | WheelEvent;

class HandlerManager {
    _map: Map;
    _el: HTMLElement;
    _handlers: Array<[string, Handler, allowed]>;
    _inertiaOptions: InertiaOptions;
    _inertiaBuffer: Array<[number, Object]>;
    _eventsInProgress: Object;
    touchPan: TouchPanHandler;
    touchZoom: TouchZoomHandler;
    touchRotate: TouchRotateHandler;
    touchPitch: TouchPitchHandler;

    /**
     * @private
     * options.inertiaOptions - linearity, easing, duration, maxSpeed
     */
    constructor(map: Map, options?: Object) {
        this._map = map;
        this._el = this._map.getCanvasContainer();
        this._handlers = [];
        this._inertiaOptions = options.inertiaOptions || defaultInertiaOptions;
        this._inertiaBuffer = [];
        this.activeHandlers = {};

        window.onerror = function(e) {
            log(e);
        }

        // Track whether map is currently moving, to compute start/move/end events
        this._eventsInProgress = {
            zoom: false,
            rotate: false,
            pitch: false,
            drag: false
        };


        this._addDefaultHandlers();

        // Bind touchstart and touchmove with passive: false because, even though
        // they only fire a map events and therefore could theoretically be
        // passive, binding with passive: true causes iOS not to respect
        // e.preventDefault() in _other_ handlers, even if they are non-passive
        // (see https://bugs.webkit.org/show_bug.cgi?id=184251)
        this.addTouchListener('touchstart', {passive: false});
        this.addTouchListener('touchmove', {passive: false});
        this.addTouchListener('touchend');
        this.addTouchListener('touchcancel');

        this.addMouseListener('mousedown');
        this.addMouseListener('mousemove');
        this.addMouseListener('mouseup');
        this.addMouseListener('mouseover');
        this.addMouseListener('mouseout');

        this.addKeyboardListener('keydown');
        this.addKeyboardListener('keyup');

        DOM.addEventListener(window.document, 'contextmenu', e => e.preventDefault());
    }

    _addDefaultHandlers() {
        this.add('mousepan', new MousePanHandler(this._map, this));
        this.add('mouserotate', new MouseRotateHandler(this._map));
        this.add('mousepitch', new MousePitchHandler(this._map));
        this.add('touchPitch', new TouchPitchHandler(this._map));
        this.add('touchPan', new TouchPanHandler(this._map), ['touchZoom','touchRotate']);
        this.add('touchZoom', new TouchZoomHandler(this._map), ['touchPan', 'touchRotate']);
        this.add('touchRotate', new TouchRotateHandler(this._map), ['touchPan', 'touchZoom']);
        this.add('keyboard', new KeyboardHandler(this._map));
    }

    add(handlerName: string, handler: Handler, allowed: Array<string>) {
        if (!handler || !(handler instanceof Handler)) throw new Error('Must provide a valid Handler instance');

        if (this[handlerName]) throw new Error(`Cannot add ${handlerName}: a handler with that name already exists`);
        this._handlers.push([handlerName, handler, allowed]);
        this[handlerName] = handler;
    }

    remove(handlerName: string) {
        if (!handlerName || typeof handlerName !== 'string') throw new Error('Must provide a valid handlerName string');
        if (!this[handlerName]) throw new Error(`Handler ${handlerName} not found`);
        const newHandlers = this._handlers.filter(([existingName, existingHandler]) => {
            if (existingName === handlerName) {
                delete this[handlerName];
                return false;
            }
            return true;
        });
        this._handlers = newHandlers;
    }

    removeAll() {
        for (const [handlerName, _] of this._handlers) this.remove(handlerName);
    }

    disableAll() {
        for (const [_, handler] of this._handlers) handler.disable();
    }

    enableAll() {
        for (const [_, handler] of this._handlers) handler.enable();
    }

    addListener(eventType: string, mapEventClass?: Class<MapMouseEvent | MapTouchEvent | MapWheelEvent>, options?: Object) {
        const listener = (e: *) => {
            if (mapEventClass) this._map.fire(new mapEventClass(eventType, this._map, e));
            this.processInputEvent(e);
        };
        DOM.addEventListener(this._el, eventType, listener, options);
    }

    addTouchListener(eventType: string, options?: Object) {
        this.addListener(eventType, MapTouchEvent, options);
    }

    addMouseListener(eventType: string, options?: Object) {
        this.addListener(eventType, MapMouseEvent, options);
    }

    addKeyboardListener(eventType: string, options?: Object) {
        this.addListener(eventType, null, extend({capture: false}, options)); // No such thing as MapKeyboardEvent to fire
    }

    stop() {
    }

    blockedByActive(activeHandlers, allowed, myName) { 
        for (const name in activeHandlers) {
            if (name === myName) continue;
            if (!allowed || allowed.indexOf(name) < 0) {
                assert(activeHandlers[name].active, 'isreally');
                //log("BLOCKER" + name);
                return true;
            }
        }
        return false;
    }

    processInputEvent(e: InputEvent) {
        //log('', true);
        // TODO
        if (e.cancelable && (e instanceof MouseEvent ? e.type === 'mousemove' : true)) e.preventDefault();
        let transformSettings = {};
        let activeHandlers = {};

        let points = e.touches ?
            DOM.touchPos(this._el, e) :
            DOM.mousePos(this._el, e);

        try {
        for (const [name, handler, allowed] of this._handlers) {
            if (!handler.isEnabled()) continue;

            if (this.blockedByActive(activeHandlers, allowed, name)) {
                handler.reset();

            } else {
                let data = handler.processInputEvent(e, points);
                if (data && data.transform) {
                    extend(transformSettings, data.transform);
                }
            }

            if (handler.active) {
                activeHandlers[name] = handler;
            } else {
                delete activeHandlers[name];
            }
        }
        } catch(e) {
            log(e);
        }

        //log('active' + Object.keys(activeHandlers));
        if (Object.keys(transformSettings).length) {
            this.updateMapTransform(transformSettings);
        }
    }

    updateMapTransform(settings: Object) {
        const map = this._map;
        this._map.stop();

        let { zoomDelta, bearingDelta, pitchDelta, setLocationAtPoint, around, panDelta } = settings;
        if (settings.duration) {
            const easeOptions = {
                duration: settings.duration,
                delayEndEvents: settings.delayEndEvents,
                easing: settings.easing
            };

            if (zoomDelta) {
                easeOptions.zoom = map.getZoom() + zoomDelta;
            }

            if (panDelta) {
                console.log(map.project(map.getCenter()), panDelta);
                easeOptions.center = map.unproject(map.project(map.getCenter()).sub(panDelta));
            }

            if (pitchDelta) {
            }

            map.easeTo(easeOptions);
            return;
        }


        const tr = this._map.transform;
        this._drainInertiaBuffer();
        this._inertiaBuffer.push([browser.now(), settings]);

        if (zoomDelta) tr.zoom += zoomDelta;
        if (bearingDelta) tr.bearing += bearingDelta;
        if (pitchDelta) tr.pitch += pitchDelta;
        if (panDelta) {
            around = around || new Point(0, 0);
            tr.setLocationAtPoint(tr.pointLocation(around.sub(panDelta)), around);
        }
        if (setLocationAtPoint && setLocationAtPoint.length === 2) {
            let [loc, pt] = setLocationAtPoint;
            tr.setLocationAtPoint(loc, pt);
        }
        this._map._update();
    }

    _drainInertiaBuffer() {
        const inertia = this._inertiaBuffer,
            now = browser.now(),
            cutoff = 160;   //msec

        while (inertia.length > 0 && now - inertia[0][0] > cutoff)
            inertia.shift();
    }

    _clampSpeed(speed: number) {
        const { maxSpeed } = this._inertiaOptions;
        if (Math.abs(speed) > maxSpeed) {
            if (speed > 0) {
                return maxSpeed;
            } else {
                return -maxSpeed;
            }
        } else {
            return speed;
        }
    }

    _onMoveEnd(originalEvent: *) {
        return;
        this._drainInertiaBuffer();
        if (this._inertiaBuffer.length < 2) {
            this._map.fire(new Event('moveend', { originalEvent }));
            return;
        }

        const {linearity, easing, maxSpeed, deceleration} = this._inertiaOptions;

        let deltas = {
            zoom: 0,
            bearing: 0,
            pitch: 0,
            pan: new Point(0, 0),
            around: null
        };
        let firstPoint, lastPoint;
        for (const [time, settings] of this._inertiaBuffer) {
            deltas.zoom += settings.zoomDelta || 0;
            deltas.bearing += settings.bearingDelta || 0;
            deltas.pitch += settings.pitchDelta || 0;
            if (settings.panDelta) deltas.pan._add(settings.panDelta);
            if (settings.around) {
                if (!firstPoint) firstPoint = settings.around;
                lastPoint = settings.around;
            }
            if (settings.setLocationAtPoint) {
                if (!firstPoint) firstPoint = settings.setLocationAtPoint[1];
                lastPoint = settings.setLocationAtPoint[1];
            }
        };

        const lastEntry = this._inertiaBuffer[this._inertiaBuffer.length - 1];
        const duration = (lastEntry[0] - this._inertiaBuffer[0][0]) / 1000;

        const easeOptions = {};

        // calculate speeds and adjust for increased initial animation speed when easing

        if (firstPoint && lastPoint) {

            let panOffset = lastPoint.sub(firstPoint);
            const velocity = panOffset.mult(linearity / duration);
            let panSpeed = velocity.mag(); // px/s

            if (panSpeed > (maxSpeed * 1000)) {
                panSpeed = maxSpeed * 1000;
                velocity._unit()._mult(panSpeed);
            }

            const panEaseDuration = (panSpeed / (deceleration * 1000 * linearity));
            easeOptions.easeDuration = Math.max(easeOptions.easeDuration || 0, panEaseDuration);
            easeOptions.offset = velocity.mult(panEaseDuration / 2);
            easeOptions.center = this._map.transform.center;
        }

        if (deltas.zoom) {
            let zoomSpeed = this._clampSpeed((deltas.zoom * linearity) / duration);
            const zoomEaseDuration = Math.abs(zoomSpeed / (deceleration * linearity)) * 1000;
            const targetZoom = (this._map.transform.zoom) + zoomSpeed * zoomEaseDuration / 2000;
            easeOptions.easeDuration = Math.max(easeOptions.easeDuration || 0, zoomEaseDuration);
            easeOptions.zoom = targetZoom;
        }

        if (deltas.bearing) {
            let bearingSpeed = this._clampSpeed((deltas.bearing * linearity) / duration);
            const bearingEaseDuration = Math.abs(bearingSpeed / (deceleration * linearity)) * 1000;
            const targetBearing = (this._map.transform.bearing) + bearingSpeed * bearingEaseDuration / 2000;
            easeOptions.easeDuration = Math.max(easeOptions.easeDuration || 0, bearingEaseDuration);
            easeOptions.bearing = targetBearing;
        }

        if (deltas.pitch) {
            let pitchSpeed = this._clampSpeed((deltas.pitch * linearity) / duration);
            const pitchEaseDuration = Math.abs(pitchSpeed / (deceleration * linearity)) * 1000;
            const targetPitch = (this._map.transform.pitch) + pitchSpeed * pitchEaseDuration / 2000;
            easeOptions.easeDuration = Math.max(easeOptions.easeDuration || 0, pitchEaseDuration);
            easeOptions.pitch = targetPitch;
        }

        if (easeOptions.zoom || easeOptions.bearing) {
            easeOptions.around = lastPoint ? this._map.unproject(lastPoint) : this._map.getCenter();
        }

        this._map.easeTo(extend(easeOptions, {
            easing,
            noMoveStart: true
        }), { originalEvent });

    }
}


export default HandlerManager;
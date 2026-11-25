"use strict";

class FuelMap {
  constructor(canvas, onSelect) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d");
    this.onSelect = onSelect;
    this.markers = [];
    new ResizeObserver(() => this.draw()).observe(canvas);
    canvas.addEventListener("wheel", event => {
      if (!this.bounds) return;
      event.preventDefault();
      this.zoom(event.deltaY < 0 ? 1.22 : 1 / 1.22, event.offsetX, event.offsetY);
    }, { passive: false });
    canvas.addEventListener("pointerdown", event => {
      if (!this.bounds || event.button !== 0 || this.drag) return;
      canvas.setPointerCapture(event.pointerId);
      this.drag = { id: event.pointerId, x: event.offsetX, y: event.offsetY, moved: false };
    });
    canvas.addEventListener("pointermove", event => {
      if (this.drag?.id !== event.pointerId) return;
      const dx = event.offsetX - this.drag.x;
      const dy = event.offsetY - this.drag.y;
      if (!this.drag.moved && Math.hypot(dx, dy) < 4) return;
      this.drag.moved = true;
      this.drag.x = event.offsetX;
      this.drag.y = event.offsetY;
      this.center.x -= dx / this.scale;
      this.center.y -= dy / this.scale;
      this.draw();
    });
    canvas.addEventListener("pointerup", event => {
      if (this.drag?.id !== event.pointerId) return;
      if (!this.drag.moved) this.pick(event.offsetX, event.offsetY);
      this.drag = null;
    });
    canvas.addEventListener("lostpointercapture", event => {
      if (this.drag?.id === event.pointerId) this.drag = null;
    });
  }

  setRegion(features, stations) {
    this.path = new Path2D();
    this.bounds = null;
    this.selected = null;
    this.markers = stations.flatMap(station => {
      const coordinates = FuelData.coordinates(station);
      return coordinates ? [{ point: FuelMap.project(coordinates), station }] : [];
    });
    let west = Infinity;
    let east = -Infinity;
    let north = Infinity;
    let south = -Infinity;
    for (const { geometry } of features) {
      const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
      for (const polygon of polygons) {
        for (const ring of polygon) {
          ring.forEach((coordinate, index) => {
            const { x, y } = FuelMap.project(coordinate);
            if (index === 0) this.path.moveTo(x, y);
            else this.path.lineTo(x, y);
            west = Math.min(west, x);
            east = Math.max(east, x);
            north = Math.min(north, y);
            south = Math.max(south, y);
          });
          this.path.closePath();
        }
      }
    }
    if (Number.isFinite(west)) this.bounds = { west, east, north, south };
    this.fit();
  }

  static project([longitude, latitude]) {
    return { x: longitude, y: -Math.log(Math.tan(Math.PI / 4 + latitude * Math.PI / 360)) * 180 / Math.PI };
  }

  fit() {
    if (this.bounds) {
      const { west, east, north, south } = this.bounds;
      this.center = { x: (east + west) / 2, y: (south + north) / 2 };
      this.scale = Math.min(
        Math.max(1, this.canvas.clientWidth - 48) / Math.max(.001, east - west),
        Math.max(1, this.canvas.clientHeight - 48) / Math.max(.001, south - north)
      );
      this.fitScale = this.scale;
    }
    this.draw();
  }

  select(station) {
    this.selected = station;
    const marker = this.markers.find(candidate => candidate.station === station);
    if (this.bounds && marker) {
      const screen = this.toScreen(marker.point);
      if (screen.x < 12 || screen.y < 12 || screen.x > this.canvas.clientWidth - 12 || screen.y > this.canvas.clientHeight - 12) {
        this.center = { ...marker.point };
      }
    }
    this.draw();
  }

  zoom(factor, x = this.canvas.clientWidth / 2, y = this.canvas.clientHeight / 2) {
    if (!this.bounds) return;
    const previous = this.scale;
    this.scale = Math.min(this.fitScale * 100, Math.max(this.fitScale / 2, previous * factor));
    this.center.x += (x - this.canvas.clientWidth / 2) * (1 / previous - 1 / this.scale);
    this.center.y += (y - this.canvas.clientHeight / 2) * (1 / previous - 1 / this.scale);
    this.draw();
  }

  toScreen(point) {
    return {
      x: this.canvas.clientWidth / 2 + (point.x - this.center.x) * this.scale,
      y: this.canvas.clientHeight / 2 + (point.y - this.center.y) * this.scale
    };
  }

  pick(x, y) {
    let closest = null;
    let distance = 12;
    for (const marker of this.markers) {
      const screen = this.toScreen(marker.point);
      const current = Math.hypot(screen.x - x, screen.y - y);
      if (current < distance) {
        closest = marker.station;
        distance = current;
      }
    }
    if (closest) this.onSelect(closest);
  }

  draw() {
    const { canvas, context } = this;
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (canvas.width !== Math.round(width * ratio)) canvas.width = Math.round(width * ratio);
    if (canvas.height !== Math.round(height * ratio)) canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    if (!this.bounds) return;

    context.save();
    context.translate(width / 2, height / 2);
    context.scale(this.scale, this.scale);
    context.translate(-this.center.x, -this.center.y);
    context.fillStyle = "#c8ded1";
    context.strokeStyle = "#5b766b";
    context.lineWidth = 0.8 / this.scale;
    context.fill(this.path, "evenodd");
    context.stroke(this.path);
    context.restore();

    const ordered = this.markers.filter(marker => marker.station !== this.selected);
    const selected = this.markers.find(marker => marker.station === this.selected);
    if (selected) ordered.push(selected);
    for (const { point, station } of ordered) {
      const { x, y } = this.toScreen(point);
      if (x < -10 || x > width + 10 || y < -10 || y > height + 10) continue;
      context.beginPath();
      context.arc(x, y, station === this.selected ? 8 : 4.5, 0, Math.PI * 2);
      context.fillStyle = station === this.selected ? "#a64714" : "#352703";
      context.strokeStyle = "#fff";
      context.lineWidth = 1.5;
      context.fill();
      context.stroke();
    }
  }
}

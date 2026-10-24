import {
  BulkPointVisualizer,
  Cartesian3,
  CustomDataSource,
  DataSourceDisplay,
  Ellipsoid,
  EntityCluster,
  Event,
  JulianDate,
  OrderedGroundPrimitiveCollection,
  PointPrimitiveCollection,
  PrimitiveCollection,
} from "../../index.js";

import createCanvas from "../../../../Specs/createCanvas.js";
import createScene from "../../../../Specs/createScene.js";

// Clustering is usually turned on after a data source has loaded. The bulk
// point visualizer keeps static points in a flat-buffer collection the cluster
// never sees, so turning clustering on or off has to move the entities it
// already holds between that collection and the cluster's own point
// collection at once, in both directions, without waiting for the
// visualizer's next update (NEW-BULK-VISUALIZER-CLUSTER-TOGGLE).
describe(
  "DataSources/BulkPointVisualizer",
  function () {
    let scene;
    let cluster;
    let dataSource;
    let time;

    beforeAll(function () {
      scene = createScene({
        canvas: createCanvas(10, 10),
      });
      // The same stand-in globe EntityClusterSpec uses: the cluster reads the
      // scene's globe, and these specs need no terrain.
      scene.globe = {
        ellipsoid: Ellipsoid.WGS84,
        _surface: {
          tileProvider: {},
          _tileLoadQueueHigh: [],
          _tileLoadQueueMedium: [],
          _tileLoadQueueLow: [],
          _debug: {
            tilesWaitingForChildren: 0,
          },
          updateHeight: function () {},
        },
        terrainProviderChanged: new Event(),
        imageryLayersUpdatedEvent: new Event(),
        tileLoadProgressEvent: new Event(),
        beginFrame: function () {},
        update: function () {},
        render: function () {},
        endFrame: function () {},
        destroy: function () {},
        isDestroyed: () => false,
        getHeight: () => 0.0,
      };

      scene.camera.setView({
        destination: Cartesian3.fromDegrees(0.0, 0.0, 10000.0),
      });
      scene.initializeFrame();
      scene.render();
    });

    afterAll(function () {
      scene.destroyForSpecs();
    });

    beforeEach(function () {
      time = JulianDate.now();
      cluster = new EntityCluster();
      cluster._initialize(scene);
      // Two entities never form a cluster of their own, so each keeps its own
      // point in the cluster's collection.
      cluster.minimumClusterSize = 3;

      dataSource = new CustomDataSource("point-cluster-toggle");
      dataSource.clustering = cluster;
      // A DataSourceDisplay gives each data source its primitive collections
      // before it runs the visualizers callback, and the default visualizers
      // require them.
      dataSource._primitives = new PrimitiveCollection();
      dataSource._groundPrimitives = new OrderedGroundPrimitiveCollection();
      dataSource._visualizers = DataSourceDisplay.defaultVisualizersCallback(
        scene,
        cluster,
        dataSource,
      );
    });

    afterEach(function () {
      for (const visualizer of dataSource._visualizers) {
        if (!visualizer.isDestroyed()) {
          visualizer.destroy();
        }
      }
      dataSource._primitives.destroy();
      dataSource._groundPrimitives.destroy();
      cluster.destroy();
    });

    function addStaticEntities() {
      return [
        dataSource.entities.add({
          position: Cartesian3.fromDegrees(0.0, 0.0),
          point: { pixelSize: 5 },
        }),
        dataSource.entities.add({
          position: Cartesian3.fromDegrees(0.001, 0.001),
          point: { pixelSize: 5 },
        }),
      ];
    }

    function bulkVisualizer() {
      return dataSource._visualizers.find(
        (visualizer) => visualizer instanceof BulkPointVisualizer,
      );
    }

    function updateVisualizers() {
      for (const visualizer of dataSource._visualizers) {
        visualizer.update(time);
      }
    }

    function countFor(collection, entities) {
      let count = 0;
      for (let i = 0; i < collection.length; i++) {
        const primitive = collection.get(i);
        if (primitive !== undefined && entities.includes(primitive.id)) {
          count++;
        }
      }
      return count;
    }

    // The points drawing these entities from the data source's own
    // flat-buffer collection.
    function bulkPrimitivesFor(entities) {
      let count = 0;
      const primitives = dataSource._primitives;
      for (let i = 0; i < primitives.length; i++) {
        const collection = primitives.get(i);
        if (collection instanceof PointPrimitiveCollection) {
          count += countFor(collection, entities);
        }
      }
      return count;
    }

    // The points drawing these entities from the cluster's own collection.
    function clusterPrimitivesFor(entities) {
      const collection = cluster._pointCollection;
      return collection === undefined ? 0 : countFor(collection, entities);
    }

    it("moves static points into the cluster when clustering is turned on, and back when it is turned off", function () {
      const entities = addStaticEntities();
      const visualizer = bulkVisualizer();
      updateVisualizers();
      cluster.update(scene.frameState);

      expect(visualizer.staticCount).toEqual(2);
      expect(visualizer.fallbackCount).toEqual(0);
      expect(bulkPrimitivesFor(entities)).toEqual(2);
      expect(clusterPrimitivesFor(entities)).toEqual(0);

      // No visualizer update between the toggle and the cluster's update.
      cluster.enabled = true;
      expect(visualizer.staticCount).toEqual(0);
      expect(visualizer.fallbackCount).toEqual(2);
      expect(bulkPrimitivesFor(entities)).toEqual(0);
      cluster.update(scene.frameState);
      expect(clusterPrimitivesFor(entities)).toEqual(2);

      // Assigning the value clustering already has changes nothing.
      cluster.enabled = true;
      expect(visualizer.staticCount).toEqual(0);
      expect(visualizer.fallbackCount).toEqual(2);
      expect(clusterPrimitivesFor(entities)).toEqual(2);

      cluster.enabled = false;
      expect(visualizer.staticCount).toEqual(2);
      expect(visualizer.fallbackCount).toEqual(0);
      expect(bulkPrimitivesFor(entities)).toEqual(2);
      cluster.update(scene.frameState);
      expect(clusterPrimitivesFor(entities)).toEqual(0);
    });

    it("moves static points between lanes on a toggle before it has ever updated", function () {
      const entities = addStaticEntities();
      const visualizer = bulkVisualizer();
      expect(visualizer.staticCount).toEqual(2);

      cluster.enabled = true;
      expect(visualizer.staticCount).toEqual(0);
      expect(visualizer.fallbackCount).toEqual(2);
      expect(bulkPrimitivesFor(entities)).toEqual(0);

      // The cluster's points appear on the visualizer's next update.
      updateVisualizers();
      cluster.update(scene.frameState);
      expect(clusterPrimitivesFor(entities)).toEqual(2);

      cluster.enabled = false;
      expect(visualizer.staticCount).toEqual(2);
      expect(visualizer.fallbackCount).toEqual(0);
      expect(bulkPrimitivesFor(entities)).toEqual(2);
      expect(clusterPrimitivesFor(entities)).toEqual(0);
    });

    it("no longer follows the cluster once destroyed", function () {
      const entities = addStaticEntities();
      const visualizer = bulkVisualizer();
      updateVisualizers();
      visualizer.destroy();

      expect(function () {
        cluster.enabled = true;
      }).not.toThrow();
      expect(visualizer.fallbackCount).toEqual(0);
      expect(function () {
        cluster.update(scene.frameState);
        cluster.enabled = false;
      }).not.toThrow();
      expect(visualizer.staticCount).toEqual(0);
      expect(clusterPrimitivesFor(entities)).toEqual(0);
    });
  },
  "WebGL",
);

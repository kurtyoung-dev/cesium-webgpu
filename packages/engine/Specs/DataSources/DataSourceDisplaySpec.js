import {
  ApproximateTerrainHeights,
  BoundingSphere,
  Cartesian3,
  Iso8601,
  BoundingSphereState,
  DataSourceCollection,
  DataSourceDisplay,
  Entity,
  GroundPolylinePrimitive,
  GroundPrimitive,
  defined,
  BulkBillboardVisualizer,
  BillboardVisualizer,
  GeometryVisualizer,
  BulkLabelVisualizer,
  LabelVisualizer,
  ModelVisualizer,
  Cesium3DTilesetVisualizer,
  BulkPointVisualizer,
  PointVisualizer,
  PathVisualizer,
  PolylineVisualizer,
} from "../../index.js";

import createScene from "../../../../Specs/createScene.js";
import MockDataSource from "../../../../Specs/MockDataSource.js";

describe(
  "DataSources/DataSourceDisplay",
  function () {
    let dataSourceCollection;
    let scene;
    let display;
    beforeAll(function () {
      scene = createScene();
      dataSourceCollection = new DataSourceCollection();

      return Promise.all([
        GroundPrimitive.initializeTerrainHeights(),
        GroundPolylinePrimitive.initializeTerrainHeights(),
      ]);
    });

    afterAll(function () {
      scene.destroyForSpecs();

      // Leave ground primitive uninitialized
      ApproximateTerrainHeights._initPromise = undefined;
      ApproximateTerrainHeights._terrainHeights = undefined;
    });

    afterEach(function () {
      if (defined(display) && !display.isDestroyed()) {
        display.destroy();
      }
      dataSourceCollection.removeAll();
    });

    function MockVisualizer() {
      this.updatesCalled = 0;
      this.lastUpdateTime = undefined;
      this.destroyed = false;

      this.getBoundingSphereResult = undefined;
      this.getBoundingSphereState = undefined;
    }

    MockVisualizer.prototype.update = function (time) {
      this.lastUpdateTime = time;
      this.updatesCalled++;
      return true;
    };

    MockVisualizer.prototype.getBoundingSphere = function (entity, result) {
      this.getBoundingSphereResult.clone(result);
      return this.getBoundingSphereState;
    };

    MockVisualizer.prototype.isDestroyed = function () {
      return this.destroyed;
    };

    MockVisualizer.prototype.destroy = function () {
      this.destroyed = true;
    };

    function visualizersCallback() {
      return [new MockVisualizer()];
    }

    it("constructor sets expected values", function () {
      display = new DataSourceDisplay({
        scene: scene,
        dataSourceCollection: dataSourceCollection,
        visualizersCallback: visualizersCallback,
      });

      expect(display.scene).toBe(scene);
      expect(display.dataSources).toBe(dataSourceCollection);
      expect(display.isDestroyed()).toEqual(false);
      expect(display.defaultDataSource).toBeDefined();

      display.destroy();
    });

    it("rolls back initialized data sources when visualizer creation fails", async function () {
      const source1 = new MockDataSource();
      const source2 = new MockDataSource();
      await dataSourceCollection.add(source1);
      await dataSourceCollection.add(source2);

      const source1Primitives = source1._primitives;
      const source1GroundPrimitives = source1._groundPrimitives;
      const source2Primitives = source2._primitives;
      const source2GroundPrimitives = source2._groundPrimitives;
      const primitiveCount = scene.primitives.length;
      const groundPrimitiveCount = scene.groundPrimitives.length;
      const cameraListenerCount = scene.camera.changed.numberOfListeners;
      const postRenderListenerCount = scene.postRender.numberOfListeners;
      const addedListenerCount =
        dataSourceCollection.dataSourceAdded.numberOfListeners;
      const removedListenerCount =
        dataSourceCollection.dataSourceRemoved.numberOfListeners;
      const movedListenerCount =
        dataSourceCollection.dataSourceMoved.numberOfListeners;
      const source1Visualizer = new MockVisualizer();
      const constructionError = new Error("visualizer construction failed");
      let callbackCount = 0;
      let thrownError;

      try {
        display = new DataSourceDisplay({
          scene: scene,
          dataSourceCollection: dataSourceCollection,
          visualizersCallback: function () {
            callbackCount++;
            if (callbackCount === 2) {
              throw constructionError;
            }
            return [source1Visualizer];
          },
        });
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBe(constructionError);
      expect(source1Visualizer.destroyed).toBe(true);
      expect(source1._primitives).toBe(source1Primitives);
      expect(source1._groundPrimitives).toBe(source1GroundPrimitives);
      expect(source1._visualizers).toBeUndefined();
      expect(source2._primitives).toBe(source2Primitives);
      expect(source2._groundPrimitives).toBe(source2GroundPrimitives);
      expect(source2._visualizers).toBeUndefined();
      expect(source1.clustering._removeEventListener).toBeUndefined();
      expect(source2.clustering._removeEventListener).toBeUndefined();
      expect(source1.destroyed).toBe(false);
      expect(source2.destroyed).toBe(false);
      expect(dataSourceCollection.length).toBe(2);
      expect(scene.primitives.length).toBe(primitiveCount);
      expect(scene.groundPrimitives.length).toBe(groundPrimitiveCount);
      expect(scene.camera.changed.numberOfListeners).toBe(cameraListenerCount);
      expect(scene.postRender.numberOfListeners).toBe(postRenderListenerCount);
      expect(dataSourceCollection.dataSourceAdded.numberOfListeners).toBe(
        addedListenerCount,
      );
      expect(dataSourceCollection.dataSourceRemoved.numberOfListeners).toBe(
        removedListenerCount,
      );
      expect(dataSourceCollection.dataSourceMoved.numberOfListeners).toBe(
        movedListenerCount,
      );
    });

    it("rolls back the default data source when late setup fails", function () {
      const dataSourceAdded = dataSourceCollection.dataSourceAdded;
      const originalAddEventListener = dataSourceAdded.addEventListener;
      const primitiveCount = scene.primitives.length;
      const groundPrimitiveCount = scene.groundPrimitives.length;
      const cameraListenerCount = scene.camera.changed.numberOfListeners;
      const postRenderListenerCount = scene.postRender.numberOfListeners;
      const addedListenerCount = dataSourceAdded.numberOfListeners;
      const defaultVisualizer = new MockVisualizer();
      const constructionError = new Error("late listener setup failed");
      let defaultDataSource;
      let addEventListenerCalls = 0;
      let thrownError;

      spyOn(dataSourceAdded, "addEventListener").and.callFake(
        function (listener, scope) {
          addEventListenerCalls++;
          if (addEventListenerCalls === 2) {
            throw constructionError;
          }
          return originalAddEventListener.call(this, listener, scope);
        },
      );

      try {
        display = new DataSourceDisplay({
          scene: scene,
          dataSourceCollection: dataSourceCollection,
          visualizersCallback: function (unusedScene, unusedCluster, source) {
            defaultDataSource = source;
            return [defaultVisualizer];
          },
        });
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBe(constructionError);
      expect(defaultVisualizer.destroyed).toBe(true);
      expect(defaultDataSource._primitives).toBeUndefined();
      expect(defaultDataSource._groundPrimitives).toBeUndefined();
      expect(defaultDataSource._visualizers).toBeUndefined();
      expect(
        defaultDataSource.entities.collectionChanged.numberOfListeners,
      ).toBe(0);
      expect(defaultDataSource.clustering._removeEventListener).toBeUndefined();
      expect(dataSourceCollection.length).toBe(0);
      expect(scene.primitives.length).toBe(primitiveCount);
      expect(scene.groundPrimitives.length).toBe(groundPrimitiveCount);
      expect(scene.camera.changed.numberOfListeners).toBe(cameraListenerCount);
      expect(scene.postRender.numberOfListeners).toBe(postRenderListenerCount);
      expect(dataSourceAdded.numberOfListeners).toBe(addedListenerCount);
    });

    it("Computes complete bounding sphere.", function () {
      const visualizer1 = new MockVisualizer();
      visualizer1.getBoundingSphereResult = new BoundingSphere(
        new Cartesian3(1, 2, 3),
        456,
      );
      visualizer1.getBoundingSphereState = BoundingSphereState.DONE;

      const visualizer2 = new MockVisualizer();
      visualizer2.getBoundingSphereResult = new BoundingSphere(
        new Cartesian3(7, 8, 9),
        1011,
      );
      visualizer2.getBoundingSphereState = BoundingSphereState.DONE;

      display = new DataSourceDisplay({
        scene: scene,
        dataSourceCollection: dataSourceCollection,
        visualizersCallback: function () {
          return [visualizer1, visualizer2];
        },
      });

      const entity = new Entity();
      const dataSource = new MockDataSource();
      dataSource.entities.add(entity);
      return display.dataSources.add(dataSource).then(function () {
        display.update(Iso8601.MINIMUM_VALUE);

        const result = new BoundingSphere();
        const state = display.getBoundingSphere(entity, true, result);

        const expected = BoundingSphere.union(
          visualizer1.getBoundingSphereResult,
          visualizer2.getBoundingSphereResult,
        );

        expect(state).toBe(BoundingSphereState.DONE);
        expect(result).toEqual(expected);
      });
    });

    it("should not return PENDING when this._ready is false and allowPartial is true", function () {
      const visualizer1 = new MockVisualizer();
      visualizer1.getBoundingSphereResult = new BoundingSphere(
        new Cartesian3(1, 2, 3),
        456,
      );
      visualizer1.getBoundingSphereState = BoundingSphereState.PENDING;

      const visualizer2 = new MockVisualizer();
      visualizer2.getBoundingSphereResult = new BoundingSphere(
        new Cartesian3(7, 8, 9),
        1011,
      );
      visualizer2.getBoundingSphereState = BoundingSphereState.DONE;

      display = new DataSourceDisplay({
        scene: scene,
        dataSourceCollection: dataSourceCollection,
        visualizersCallback: function () {
          return [visualizer1, visualizer2];
        },
      });

      const entity = new Entity();
      const dataSource = new MockDataSource();
      dataSource.entities.add(entity);
      return display.dataSources.add(dataSource).then(function () {
        display.update(Iso8601.MINIMUM_VALUE);

        const result = new BoundingSphere();
        const state = display.getBoundingSphere(entity, true, result);

        expect(state).toBe(BoundingSphereState.DONE);
      });
    });

    it("Computes partial bounding sphere.", function () {
      const visualizer1 = new MockVisualizer();
      visualizer1.getBoundingSphereResult = new BoundingSphere(
        new Cartesian3(1, 2, 3),
        456,
      );
      visualizer1.getBoundingSphereState = BoundingSphereState.PENDING;

      const visualizer2 = new MockVisualizer();
      visualizer2.getBoundingSphereResult = new BoundingSphere(
        new Cartesian3(7, 8, 9),
        1011,
      );
      visualizer2.getBoundingSphereState = BoundingSphereState.DONE;

      display = new DataSourceDisplay({
        scene: scene,
        dataSourceCollection: dataSourceCollection,
        visualizersCallback: function () {
          return [visualizer1, visualizer2];
        },
      });

      const entity = new Entity();
      const dataSource = new MockDataSource();
      dataSource.entities.add(entity);
      return display.dataSources.add(dataSource).then(function () {
        display.update(Iso8601.MINIMUM_VALUE);

        const result = new BoundingSphere();
        const state = display.getBoundingSphere(entity, true, result);

        expect(state).toBe(BoundingSphereState.DONE);
        expect(result).toEqual(visualizer2.getBoundingSphereResult);
      });
    });

    it("Fails complete bounding sphere if allowPartial false.", function () {
      const visualizer1 = new MockVisualizer();
      visualizer1.getBoundingSphereResult = new BoundingSphere(
        new Cartesian3(1, 2, 3),
        456,
      );
      visualizer1.getBoundingSphereState = BoundingSphereState.PENDING;

      const visualizer2 = new MockVisualizer();
      visualizer2.getBoundingSphereResult = new BoundingSphere(
        new Cartesian3(7, 8, 9),
        1011,
      );
      visualizer2.getBoundingSphereState = BoundingSphereState.DONE;

      display = new DataSourceDisplay({
        scene: scene,
        dataSourceCollection: dataSourceCollection,
        visualizersCallback: function () {
          return [visualizer1, visualizer2];
        },
      });

      const entity = new Entity();
      display.defaultDataSource.entities.add(entity);

      const result = new BoundingSphere();
      const state = display.getBoundingSphere(entity, false, result);

      expect(state).toBe(BoundingSphereState.PENDING);
    });

    it("Fails bounding sphere for entity without visualization.", function () {
      display = new DataSourceDisplay({
        dataSourceCollection: dataSourceCollection,
        scene: scene,
      });
      const entity = new Entity();
      const dataSource = new MockDataSource();
      dataSource.entities.add(entity);
      return display.dataSources.add(dataSource).then(function () {
        display.update(Iso8601.MINIMUM_VALUE);

        const result = new BoundingSphere();
        const state = display.getBoundingSphere(entity, false, result);
        expect(state).toBe(BoundingSphereState.FAILED);
        display.destroy();
      });
    });

    it("Fails bounding sphere for entity not in a data source.", function () {
      display = new DataSourceDisplay({
        dataSourceCollection: dataSourceCollection,
        scene: scene,
      });
      display.update(Iso8601.MINIMUM_VALUE);

      const entity = new Entity();
      const result = new BoundingSphere();
      const state = display.getBoundingSphere(entity, false, result);
      expect(state).toBe(BoundingSphereState.FAILED);
      display.destroy();
    });

    it("Compute bounding sphere throws without entity.", function () {
      display = new DataSourceDisplay({
        dataSourceCollection: dataSourceCollection,
        scene: scene,
      });
      const result = new BoundingSphere();
      expect(function () {
        display.getBoundingSphere(undefined, false, result);
      }).toThrowDeveloperError();
    });

    it("Compute bounding sphere throws without result.", function () {
      display = new DataSourceDisplay({
        dataSourceCollection: dataSourceCollection,
        scene: scene,
      });
      const entity = new Entity();
      expect(function () {
        display.getBoundingSphere(entity, false, undefined);
      }).toThrowDeveloperError();
    });

    it("Compute bounding sphere throws without allowPartial.", function () {
      display = new DataSourceDisplay({
        dataSourceCollection: dataSourceCollection,
        scene: scene,
      });
      const entity = new Entity();
      const result = new BoundingSphere();
      expect(function () {
        display.getBoundingSphere(entity, undefined, result);
      }).toThrowDeveloperError();
    });

    it("destroy does not destroy underlying data sources", function () {
      const dataSource = new MockDataSource();
      return dataSourceCollection.add(dataSource).then(function () {
        display = new DataSourceDisplay({
          scene: scene,
          dataSourceCollection: dataSourceCollection,
        });

        expect(dataSource.destroyed).toEqual(false);

        display.destroy();

        expect(dataSource.destroyed).toEqual(false);
        expect(display.isDestroyed()).toEqual(true);
      });
    });

    it("calling update updates data sources", function () {
      const source1 = new MockDataSource();
      const source2 = new MockDataSource();

      display = new DataSourceDisplay({
        scene: scene,
        dataSourceCollection: dataSourceCollection,
        visualizersCallback: visualizersCallback,
      });
      return Promise.all([
        dataSourceCollection.add(source1),
        dataSourceCollection.add(source2),
      ]).then(function () {
        const source1Visualizer = source1._visualizers[0];
        expect(source1Visualizer).toBeInstanceOf(MockVisualizer);

        const source2Visualizer = source2._visualizers[0];
        expect(source2Visualizer).toBeInstanceOf(MockVisualizer);

        //Nothing should have happened yet because we haven't called update.
        expect(source1Visualizer.updatesCalled).toEqual(0);
        expect(source2Visualizer.updatesCalled).toEqual(0);

        //Update should call update on the visualizers
        display.update(Iso8601.MINIMUM_VALUE);
        expect(source1Visualizer.lastUpdateTime).toEqual(Iso8601.MINIMUM_VALUE);
        expect(source1Visualizer.updatesCalled).toEqual(1);
        expect(source2Visualizer.lastUpdateTime).toEqual(Iso8601.MINIMUM_VALUE);
        expect(source2Visualizer.updatesCalled).toEqual(1);
      });
    });

    it("ready is true once datasources are ready and stays true", async function () {
      const source1 = new MockDataSource();
      const source2 = new MockDataSource();

      display = new DataSourceDisplay({
        scene: scene,
        dataSourceCollection: dataSourceCollection,
        visualizersCallback: visualizersCallback,
      });
      expect(display.ready).withContext("before adding sources").toBe(false);

      await Promise.all([
        dataSourceCollection.add(source1),
        dataSourceCollection.add(source2),
      ]);

      display.update(Iso8601.MINIMUM_VALUE);
      expect(display.ready).withContext("after adding sources").toBe(true);

      spyOn(MockVisualizer.prototype, "update").and.returnValue(false);
      display.update(Iso8601.MINIMUM_VALUE);
      expect(display.ready).withContext("after updating again").toBe(true);
    });

    it("triggers a rendering when the data source becomes ready", function () {
      scene.requestRenderMode = true;
      scene.maximumRenderTimeChange = undefined;

      // When the scene is constructed, then a listener that will be added via
      // RequestScheduler.requestCompletedEvent.addEventListener
      // that requests a single render (by putting a call to scene.requestRender()
      // into the scene._frameState.afterRender list). The requestCompletedEvent
      // is triggered when the request for the terrain heights completes that
      // is initiated via GroundPolylinePrimitive.initializeTerrainHeights()
      // in beforeAll of this suite.
      // Consume this render request here
      scene.renderForSpecs();

      const source = new MockDataSource();
      display = new DataSourceDisplay({
        scene: scene,
        dataSourceCollection: dataSourceCollection,
        visualizersCallback: visualizersCallback,
      });
      expect(display.ready).toBe(false);

      return dataSourceCollection.add(source).then(function () {
        // When the source becomes ready, a render should
        // be requested
        display.update(Iso8601.MINIMUM_VALUE);
        expect(display.ready).toBe(true);
        expect(scene._renderRequested).toBe(true);

        scene.renderForSpecs();

        // The source should remain ready during subsequent updates,
        // and no further renders should be requested
        display.update(Iso8601.MINIMUM_VALUE);
        expect(display.ready).toBe(true);
        expect(scene._renderRequested).toBe(false);
      });
    });

    it("constructor throws if scene undefined", function () {
      expect(function () {
        return new DataSourceDisplay({
          scene: undefined,
          dataSourceCollection: dataSourceCollection,
          visualizersCallback: visualizersCallback,
        });
      }).toThrowDeveloperError();
    });

    it("constructor throws if options undefined", function () {
      expect(function () {
        return new DataSourceDisplay(undefined);
      }).toThrowDeveloperError();
    });

    it("constructor throws if dataSourceCollection undefined", function () {
      expect(function () {
        return new DataSourceDisplay({
          scene: scene,
          dataSourceCollection: undefined,
          visualizersCallback: visualizersCallback,
        });
      }).toThrowDeveloperError();
    });

    it("update throws if time undefined", function () {
      display = new DataSourceDisplay({
        scene: scene,
        dataSourceCollection: dataSourceCollection,
        visualizersCallback: visualizersCallback,
      });
      expect(function () {
        return display.update();
      }).toThrowDeveloperError();
    });

    it("verify update returns false till terrain heights are initialized", function () {
      ApproximateTerrainHeights._initPromise = undefined;
      ApproximateTerrainHeights._terrainHeights = undefined;

      const source1 = new MockDataSource();
      const source2 = new MockDataSource();

      display = new DataSourceDisplay({
        scene: scene,
        dataSourceCollection: dataSourceCollection,
        visualizersCallback: visualizersCallback,
      });
      return Promise.all([
        dataSourceCollection.add(source1),
        dataSourceCollection.add(source2),
      ])
        .then(function () {
          display.update(Iso8601.MINIMUM_VALUE);
          expect(display.ready).toBe(false);

          return GroundPrimitive.initializeTerrainHeights();
        })
        .then(function () {
          display.update(Iso8601.MINIMUM_VALUE);
          expect(display.ready).toBe(true);
        });
    });

    it("sets dataSource primitives on add", function () {
      const source = new MockDataSource();

      display = new DataSourceDisplay({
        scene: scene,
        dataSourceCollection: dataSourceCollection,
        visualizersCallback: visualizersCallback,
      });

      return dataSourceCollection.add(source).then(function () {
        expect(source._primitives).toBeDefined();
        expect(source._groundPrimitives).toBeDefined();

        expect(display._primitives.contains(source._primitives)).toBe(true);
        expect(
          display._groundPrimitives.contains(source._groundPrimitives),
        ).toBe(true);
      });
    });

    it("cleans up primitives on dataSource removed", function () {
      const source = new MockDataSource();

      display = new DataSourceDisplay({
        scene: scene,
        dataSourceCollection: dataSourceCollection,
        visualizersCallback: visualizersCallback,
      });

      return dataSourceCollection.add(source).then(function () {
        expect(display._primitives.contains(source._primitives)).toBe(true);
        expect(
          display._groundPrimitives.contains(source._groundPrimitives),
        ).toBe(true);

        dataSourceCollection.remove(source);

        expect(display._primitives.length).toBe(1);
        expect(display._groundPrimitives.length).toBe(1);
      });
    });

    it("raises primitives on dataSource raise", function () {
      const source1 = new MockDataSource();
      const source2 = new MockDataSource();
      const source3 = new MockDataSource();

      display = new DataSourceDisplay({
        scene: scene,
        dataSourceCollection: dataSourceCollection,
        visualizersCallback: visualizersCallback,
      });

      return Promise.all([
        dataSourceCollection.add(source1),
        dataSourceCollection.add(source2),
        dataSourceCollection.add(source3),
      ]).then(function () {
        dataSourceCollection.raise(source1);

        expect(display._primitives.get(1)).toBe(source2._primitives);
        expect(display._primitives.get(2)).toBe(source1._primitives);
        expect(display._primitives.get(3)).toBe(source3._primitives);
      });
    });

    it("lowers primitives on dataSource lower", function () {
      const source1 = new MockDataSource();
      const source2 = new MockDataSource();
      const source3 = new MockDataSource();

      display = new DataSourceDisplay({
        scene: scene,
        dataSourceCollection: dataSourceCollection,
        visualizersCallback: visualizersCallback,
      });

      return Promise.all([
        dataSourceCollection.add(source1),
        dataSourceCollection.add(source2),
        dataSourceCollection.add(source3),
      ]).then(function () {
        dataSourceCollection.lower(source3);

        expect(display._primitives.get(1)).toBe(source1._primitives);
        expect(display._primitives.get(2)).toBe(source3._primitives);
        expect(display._primitives.get(3)).toBe(source2._primitives);
      });
    });

    it("raises primitives to top on dataSource raiseToTop", function () {
      const source1 = new MockDataSource();
      const source2 = new MockDataSource();
      const source3 = new MockDataSource();

      display = new DataSourceDisplay({
        scene: scene,
        dataSourceCollection: dataSourceCollection,
        visualizersCallback: visualizersCallback,
      });

      return Promise.all([
        dataSourceCollection.add(source1),
        dataSourceCollection.add(source2),
        dataSourceCollection.add(source3),
      ]).then(function () {
        dataSourceCollection.raiseToTop(source1);

        expect(display._primitives.get(1)).toBe(source2._primitives);
        expect(display._primitives.get(2)).toBe(source3._primitives);
        expect(display._primitives.get(3)).toBe(source1._primitives);
      });
    });

    it("lowers primitives to bottom on dataSource lowerToBottom", function () {
      const source1 = new MockDataSource();
      const source2 = new MockDataSource();
      const source3 = new MockDataSource();

      display = new DataSourceDisplay({
        scene: scene,
        dataSourceCollection: dataSourceCollection,
        visualizersCallback: visualizersCallback,
      });

      return Promise.all([
        dataSourceCollection.add(source1),
        dataSourceCollection.add(source2),
        dataSourceCollection.add(source3),
      ]).then(function () {
        dataSourceCollection.lowerToBottom(source3);

        expect(display._primitives.get(1)).toBe(source3._primitives);
        expect(display._primitives.get(2)).toBe(source1._primitives);
        expect(display._primitives.get(3)).toBe(source2._primitives);
      });
    });

    it("adds primitives to scene when dataSource is added to the collection", function () {
      display = new DataSourceDisplay({
        scene: scene,
        dataSourceCollection: dataSourceCollection,
        visualizersCallback: visualizersCallback,
      });
      expect(scene.primitives.contains(display._primitives)).toBe(false);
      expect(scene.groundPrimitives.contains(display._groundPrimitives)).toBe(
        false,
      );

      return dataSourceCollection.add(new MockDataSource()).then(function () {
        expect(scene.primitives.contains(display._primitives)).toBe(true);
        expect(scene.groundPrimitives.contains(display._groundPrimitives)).toBe(
          true,
        );
      });
    });

    it("adds primitives to scene if dataSourceCollection is not empty", function () {
      return dataSourceCollection.add(new MockDataSource()).then(function () {
        display = new DataSourceDisplay({
          scene: scene,
          dataSourceCollection: dataSourceCollection,
          visualizersCallback: visualizersCallback,
        });

        expect(scene.primitives.contains(display._primitives)).toBe(true);
        expect(scene.groundPrimitives.contains(display._groundPrimitives)).toBe(
          true,
        );
      });
    });

    it("adds primitives to the scene when entities are added to the default dataSource", function () {
      display = new DataSourceDisplay({
        scene: scene,
        dataSourceCollection: dataSourceCollection,
        visualizersCallback: visualizersCallback,
      });
      expect(scene.primitives.contains(display._primitives)).toBe(false);
      expect(scene.groundPrimitives.contains(display._groundPrimitives)).toBe(
        false,
      );

      display.defaultDataSource.entities.add(new Entity());

      expect(scene.primitives.contains(display._primitives)).toBe(true);
      expect(scene.groundPrimitives.contains(display._groundPrimitives)).toBe(
        true,
      );
    });

    it("has expected default visualizers", () => {
      const dataSource = new MockDataSource();
      const entityCluster = dataSource.clustering;
      const callback = DataSourceDisplay.defaultVisualizersCallback(
        scene,
        entityCluster,
        dataSource,
      );
      expect(callback.length).toEqual(8);
      expect(callback[0]).toBeInstanceOf(BulkBillboardVisualizer);
      expect(callback[1]).toBeInstanceOf(GeometryVisualizer);
      expect(callback[2]).toBeInstanceOf(BulkLabelVisualizer);
      expect(callback[3]).toBeInstanceOf(ModelVisualizer);
      expect(callback[4]).toBeInstanceOf(Cesium3DTilesetVisualizer);
      expect(callback[5]).toBeInstanceOf(BulkPointVisualizer);
      expect(callback[6]).toBeInstanceOf(PathVisualizer);
      expect(callback[7]).toBeInstanceOf(PolylineVisualizer);
    });

    it("legacyVisualizersCallback wires the per-frame (non-bulk) billboard/label/point visualizers", () => {
      const dataSource = new MockDataSource();
      const entityCluster = dataSource.clustering;
      const callback = DataSourceDisplay.legacyVisualizersCallback(
        scene,
        entityCluster,
        dataSource,
      );
      expect(callback.length).toEqual(8);
      // billboard / label / point are the LEGACY per-frame visualizers, NOT the
      // bulk static-lane fast path (the opt-in toggle for short-lived sources).
      expect(callback[0]).toBeInstanceOf(BillboardVisualizer);
      expect(callback[0]).not.toBeInstanceOf(BulkBillboardVisualizer);
      expect(callback[1]).toBeInstanceOf(GeometryVisualizer);
      expect(callback[2]).toBeInstanceOf(LabelVisualizer);
      expect(callback[2]).not.toBeInstanceOf(BulkLabelVisualizer);
      expect(callback[3]).toBeInstanceOf(ModelVisualizer);
      expect(callback[4]).toBeInstanceOf(Cesium3DTilesetVisualizer);
      expect(callback[5]).toBeInstanceOf(PointVisualizer);
      expect(callback[5]).not.toBeInstanceOf(BulkPointVisualizer);
      expect(callback[6]).toBeInstanceOf(PathVisualizer);
      expect(callback[7]).toBeInstanceOf(PolylineVisualizer);
    });

    it("registers extra visualizers", () => {
      function FakeVisualizer() {}
      const dataSource = new MockDataSource();
      const entityCluster = dataSource.clustering;

      const callback = DataSourceDisplay.defaultVisualizersCallback(
        scene,
        entityCluster,
        dataSource,
      );
      expect(callback.length).withContext("length before register").toEqual(8);

      DataSourceDisplay.registerVisualizer(FakeVisualizer);
      const callback2 = DataSourceDisplay.defaultVisualizersCallback(
        scene,
        entityCluster,
        dataSource,
      );
      expect(callback2.length).withContext("length after register").toEqual(9);
      expect(callback2[8]).toBeInstanceOf(FakeVisualizer);

      DataSourceDisplay.unregisterVisualizer(FakeVisualizer);
      const callback3 = DataSourceDisplay.defaultVisualizersCallback(
        scene,
        entityCluster,
        dataSource,
      );
      expect(callback3.length)
        .withContext("length after unregister")
        .toEqual(8);
    });
  },
  "WebGL",
);

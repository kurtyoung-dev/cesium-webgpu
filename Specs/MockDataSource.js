import {
  Event,
  EntityCluster,
  EntityCollection,
  PrimitiveCollection,
} from "@cesium/engine";

function MockDataSource() {
  //Values to be fiddled with by the test
  this.changedEvent = new Event();
  this.errorEvent = new Event();
  this.entities = new EntityCollection();
  this.name = "Mock Data";
  this.clock = undefined;
  this.isTimeVarying = false;
  this.isLoading = false;
  this.loadingEvent = new Event();
  this.destroyed = false;
  this.clustering = new EntityCluster();
  // The bulk visualizers (point/billboard/label) add their flat-buffer
  // collections to the DataSource's own primitives; provide one so
  // defaultVisualizersCallback can construct them.
  this._primitives = new PrimitiveCollection();
  this._groundPrimitives = new PrimitiveCollection();
}
MockDataSource.prototype.update = function () {
  return true;
};

MockDataSource.prototype.destroy = function () {
  this.destroyed = true;
};
export default MockDataSource;

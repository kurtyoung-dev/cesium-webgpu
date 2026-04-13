import clone from "../Core/clone.js";
import combine from "../Core/combine.js";
import createGuid from "../Core/createGuid.js";
import Frozen from "../Core/Frozen.js";
import defined from "../Core/defined.js";
import DeveloperError from "../Core/DeveloperError.js";
import loadKTX2 from "../Core/loadKTX2.js";
import Matrix2 from "../Core/Matrix2.js";
import Matrix3 from "../Core/Matrix3.js";
import Matrix4 from "../Core/Matrix4.js";
import Resource from "../Core/Resource.js";
import CubeMap from "../Renderer/CubeMap.js";
import Sampler from "../Renderer/Sampler.js";
import Texture from "../Renderer/Texture.js";
import MaterialUniformBuffer from "./MaterialUniformBuffer.js";

/**
 * Gets or sets the default texture uniform value.
 * @type {string}
 */
const DEFAULT_IMAGE_ID = "czm_defaultImage";

/**
 * Gets or sets the default cube map texture uniform value.
 * @type {string}
 */
const DEFAULT_CUBE_MAP_ID = "czm_defaultCubeMap";

/**
 * Cache of material templates indexed by type name.
 * @private
 */
const materialCache = {
  _materials: {},
  addMaterial(type, materialTemplate) {
    this._materials[type] = materialTemplate;
  },
  getMaterial(type) {
    return this._materials[type];
  },
};

const templateProperties = [
  "type",
  "materials",
  "uniforms",
  "components",
  "source",
];

const componentProperties = [
  "diffuse",
  "specular",
  "shininess",
  "normal",
  "emission",
  "alpha",
];

const matrixMap = {
  mat2: Matrix2,
  mat3: Matrix3,
  mat4: Matrix4,
};

const ktx2Regex = /\.ktx2$/i;

function checkForValidProperties(object, properties, result, throwNotFound) {
  if (defined(object)) {
    for (const property in object) {
      if (object.hasOwnProperty(property)) {
        const hasProperty = properties.includes(property);
        if (
          (throwNotFound && !hasProperty) ||
          (!throwNotFound && hasProperty)
        ) {
          result(property, properties);
        }
      }
    }
  }
}

function invalidNameError(property, properties) {
  //>>includeStart('debug', pragmas.debug);
  let errorString = `fabric: property name '${property}' is not valid. It should be `;
  for (let i = 0; i < properties.length; i++) {
    const propertyName = `'${properties[i]}'`;
    errorString +=
      i === properties.length - 1 ? `or ${propertyName}.` : `${propertyName}, `;
  }
  throw new DeveloperError(errorString);
  //>>includeEnd('debug');
}

function duplicateNameError(property, properties) {
  //>>includeStart('debug', pragmas.debug);
  const errorString = `fabric: uniforms and materials cannot share the same property '${property}'`;
  throw new DeveloperError(errorString);
  //>>includeEnd('debug');
}

function checkForTemplateErrors(material) {
  const template = material._template;
  const uniforms = template.uniforms;
  const materials = template.materials;
  const components = template.components;

  // Make sure source and components do not exist in the same template.
  //>>includeStart('debug', pragmas.debug);
  if (defined(components) && defined(template.source)) {
    throw new DeveloperError(
      "fabric: cannot have source and components in the same template.",
    );
  }
  //>>includeEnd('debug');

  // Make sure all template and components properties are valid.
  checkForValidProperties(template, templateProperties, invalidNameError, true);
  checkForValidProperties(
    components,
    componentProperties,
    invalidNameError,
    true,
  );

  // Make sure uniforms and materials do not share any of the same names.
  const materialNames = [];
  for (const property in materials) {
    if (materials.hasOwnProperty(property)) {
      materialNames.push(property);
    }
  }
  checkForValidProperties(uniforms, materialNames, duplicateNameError, false);
}

function isMaterialFused(shaderComponent, material) {
  const materials = material._template.materials;
  for (const subMaterialId in materials) {
    if (materials.hasOwnProperty(subMaterialId)) {
      if (shaderComponent.includes(subMaterialId)) {
        return true;
      }
    }
  }

  return false;
}

// Create the czm_getMaterial method body using source or components.
function createMethodDefinition(material) {
  const components = material._template.components;
  const source = material._template.source;
  if (defined(source)) {
    material.shaderSource += `${source}\n`;
  } else {
    material.shaderSource +=
      "czm_material czm_getMaterial(czm_materialInput materialInput)\n{\n";
    material.shaderSource +=
      "czm_material material = czm_getDefaultMaterial(materialInput);\n";
    if (defined(components)) {
      const isMultiMaterial =
        Object.keys(material._template.materials).length > 0;
      for (const component in components) {
        if (components.hasOwnProperty(component)) {
          if (component === "diffuse" || component === "emission") {
            const isFusion =
              isMultiMaterial &&
              isMaterialFused(components[component], material);
            const componentSource = isFusion
              ? components[component]
              : `czm_gammaCorrect(${components[component]})`;
            material.shaderSource += `material.${component} = ${componentSource}; \n`;
          } else if (component === "alpha") {
            material.shaderSource += `material.alpha = ${components.alpha}; \n`;
          } else {
            material.shaderSource += `material.${component} = ${components[component]};\n`;
          }
        }
      }
    }
    material.shaderSource += "return material;\n}\n";
  }
}

/**
 * @private
 */
function createTexture2DUpdateFunction(uniformId) {
  let oldUniformValue;
  return function (material, context) {
    const uniforms = material.uniforms;
    const uniformValue = uniforms[uniformId];
    const uniformChanged = oldUniformValue !== uniformValue;
    const uniformValueIsDefaultImage =
      !defined(uniformValue) || uniformValue === DEFAULT_IMAGE_ID;
    oldUniformValue = uniformValue;

    let texture = material._textures[uniformId];
    let uniformDimensionsName;
    let uniformDimensions;

    if (uniformValue instanceof HTMLVideoElement) {
      // HTMLVideoElement.readyState >=2 means we have enough data for the current frame.
      // See: https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/readyState
      if (uniformValue.readyState >= 2) {
        if (uniformChanged && defined(texture)) {
          if (texture !== context.defaultTexture) {
            texture.destroy();
          }
          texture = undefined;
        }

        if (!defined(texture) || texture === context.defaultTexture) {
          const sampler = new Sampler({
            minificationFilter: material._minificationFilter,
            magnificationFilter: material._magnificationFilter,
          });
          texture = new Texture({
            context: context,
            source: uniformValue,
            sampler: sampler,
          });
          material._textures[uniformId] = texture;
          return;
        }

        texture.copyFrom({
          source: uniformValue,
        });
      } else if (!defined(texture)) {
        material._textures[uniformId] = context.defaultTexture;
      }
      return;
    }

    if (uniformValue instanceof Texture && uniformValue !== texture) {
      material._texturePaths[uniformId] = undefined;
      const tmp = material._textures[uniformId];
      if (defined(tmp) && tmp !== material._defaultTexture) {
        tmp.destroy();
      }
      material._textures[uniformId] = uniformValue;

      uniformDimensionsName = `${uniformId}Dimensions`;
      if (uniforms.hasOwnProperty(uniformDimensionsName)) {
        uniformDimensions = uniforms[uniformDimensionsName];
        uniformDimensions.x = uniformValue._width;
        uniformDimensions.y = uniformValue._height;
      }

      return;
    }

    if (uniformChanged && defined(texture) && uniformValueIsDefaultImage) {
      // If the newly-assigned texture is the default texture,
      // we don't need to wait for a new image to load before destroying
      // the old texture.
      if (texture !== material._defaultTexture) {
        texture.destroy();
      }
      texture = undefined;
      material._texturePaths[uniformId] = undefined;
    }

    if (!defined(texture)) {
      texture = material._textures[uniformId] = material._defaultTexture;

      uniformDimensionsName = `${uniformId}Dimensions`;
      if (uniforms.hasOwnProperty(uniformDimensionsName)) {
        uniformDimensions = uniforms[uniformDimensionsName];
        uniformDimensions.x = texture._width;
        uniformDimensions.y = texture._height;
      }
    }

    if (uniformValueIsDefaultImage) {
      return;
    }

    if (
      (uniformValue instanceof HTMLCanvasElement ||
        uniformValue instanceof HTMLImageElement ||
        uniformValue instanceof ImageBitmap ||
        uniformValue instanceof OffscreenCanvas) &&
      uniformValue !== material._texturePaths[uniformId]
    ) {
      material._loadedImages.push({
        id: uniformId,
        image: uniformValue,
      });
      material._texturePaths[uniformId] = uniformValue;
      return;
    }

    // If we get to this point, the image should be a string URL or Resource.
    // Don't wait on the promise to resolve, just start loading the image and poll status from the update loop.
    loadTexture2DImageForUniform(material, uniformId);
  };
}

/**
 * For a given uniform ID, potentially loads a texture image for the material, if the uniform value is a Resource or string URL,
 * and has changed since the last time this was called (either on construction or update).
 *
 * @param {Material} material The material to load the texture for.
 * @param {string} uniformId The ID of the uniform of the image.
 * @returns A promise that resolves when the image is loaded, or a resolved promise if image loading is not necessary.
 *
 * @private
 */
function loadTexture2DImageForUniform(material, uniformId) {
  const uniforms = material.uniforms;
  const uniformValue = uniforms[uniformId];
  if (uniformValue === DEFAULT_IMAGE_ID) {
    return Promise.resolve();
  }

  // Attempt to make a resource from the uniform value. If it's not already a resource or string, this returns the original object.
  const resource = Resource.createIfNeeded(uniformValue);
  if (!(resource instanceof Resource)) {
    return Promise.resolve();
  }

  // When using the entity layer, the Resource objects get recreated on getValue because
  // they are clonable. That's why we check the url property for Resources
  // because the instances aren't the same and we keep trying to load the same
  // image if it fails to load.
  const oldResource = Resource.createIfNeeded(
    material._texturePaths[uniformId],
  );
  const uniformHasChanged =
    !defined(oldResource) || oldResource.url !== resource.url;
  if (!uniformHasChanged) {
    return Promise.resolve();
  }

  let promise;
  if (ktx2Regex.test(resource.url)) {
    promise = loadKTX2(resource.url);
  } else {
    promise = resource.fetchImage();
  }

  Promise.resolve(promise)
    .then(function (image) {
      material._loadedImages.push({
        id: uniformId,
        image: image,
      });
    })
    .catch(function (error) {
      material._initializationError = error;
      const texture = material._textures[uniformId];
      if (defined(texture) && texture !== material._defaultTexture) {
        texture.destroy();
      }
      material._textures[uniformId] = material._defaultTexture;
    });

  material._texturePaths[uniformId] = uniformValue;
  return promise;
}

/**
 * @private
 */
function createCubeMapUpdateFunction(uniformId) {
  return function (material, context) {
    const uniformValue = material.uniforms[uniformId];

    if (uniformValue instanceof CubeMap) {
      const tmp = material._textures[uniformId];
      if (tmp !== material._defaultTexture) {
        tmp.destroy();
      }
      material._texturePaths[uniformId] = undefined;
      material._textures[uniformId] = uniformValue;
      return;
    }

    if (!defined(material._textures[uniformId])) {
      material._textures[uniformId] = context.defaultCubeMap;
    }

    loadCubeMapImagesForUniform(material, uniformId);
  };
}

/**
 * Loads the images for a cubemap uniform, if it has changed since the last time this was called.
 *
 * @param {Material} material The material to load the cubemap images for.
 * @param {string} uniformId The ID of the uniform that corresponds to the cubemap images.
 * @returns A promise that resolves when the images are loaded, or a resolved promise if image loading is not necessary.
 */
function loadCubeMapImagesForUniform(material, uniformId) {
  const uniforms = material.uniforms;
  const uniformValue = uniforms[uniformId];
  if (uniformValue === DEFAULT_CUBE_MAP_ID) {
    return Promise.resolve();
  }

  const path =
    uniformValue.positiveX +
    uniformValue.negativeX +
    uniformValue.positiveY +
    uniformValue.negativeY +
    uniformValue.positiveZ +
    uniformValue.negativeZ;

  // The uniform value is unchanged, no update / image load necessary.
  if (path === material._texturePaths[uniformId]) {
    return Promise.resolve();
  }

  const promises = [
    Resource.createIfNeeded(uniformValue.positiveX).fetchImage(),
    Resource.createIfNeeded(uniformValue.negativeX).fetchImage(),
    Resource.createIfNeeded(uniformValue.positiveY).fetchImage(),
    Resource.createIfNeeded(uniformValue.negativeY).fetchImage(),
    Resource.createIfNeeded(uniformValue.positiveZ).fetchImage(),
    Resource.createIfNeeded(uniformValue.negativeZ).fetchImage(),
  ];

  const allPromise = Promise.all(promises);
  allPromise
    .then(function (images) {
      material._loadedCubeMaps.push({
        id: uniformId,
        images: images,
      });
    })
    .catch(function (error) {
      material._initializationError = error;
    });

  material._texturePaths[uniformId] = path;

  return allPromise;
}

function createUniforms(material) {
  const uniforms = material._template.uniforms;
  for (const uniformId in uniforms) {
    if (uniforms.hasOwnProperty(uniformId)) {
      createUniform(material, uniformId);
    }
  }
}

// Writes uniform declarations to the shader file and connects uniform values with
// corresponding material properties through the returnUniforms function.
function createUniform(material, uniformId) {
  const strict = material._strict;
  const materialUniforms = material._template.uniforms;
  const uniformValue = materialUniforms[uniformId];
  const uniformType = getUniformType(uniformValue);

  //>>includeStart('debug', pragmas.debug);
  if (!defined(uniformType)) {
    throw new DeveloperError(
      `fabric: uniform '${uniformId}' has invalid type.`,
    );
  }
  //>>includeEnd('debug');

  let replacedTokenCount;
  if (uniformType === "channels") {
    replacedTokenCount = replaceToken(material, uniformId, uniformValue, false);
    //>>includeStart('debug', pragmas.debug);
    if (replacedTokenCount === 0 && strict) {
      throw new DeveloperError(
        `strict: shader source does not use channels '${uniformId}'.`,
      );
    }
    //>>includeEnd('debug');
  } else {
    // Since webgl doesn't allow texture dimension queries in glsl, create a uniform to do it.
    // Check if the shader source actually uses texture dimensions before creating the uniform.
    if (uniformType === "sampler2D") {
      const imageDimensionsUniformName = `${uniformId}Dimensions`;
      if (getNumberOfTokens(material, imageDimensionsUniformName) > 0) {
        materialUniforms[imageDimensionsUniformName] = {
          type: "ivec3",
          x: 1,
          y: 1,
        };
        createUniform(material, imageDimensionsUniformName);
      }
    }

    // Add uniform declaration to source code.
    const uniformDeclarationRegex = new RegExp(
      `uniform\\s+${uniformType}\\s+${uniformId}\\s*;`,
    );
    if (!uniformDeclarationRegex.test(material.shaderSource)) {
      const uniformDeclaration = `uniform ${uniformType} ${uniformId};`;
      material.shaderSource = uniformDeclaration + material.shaderSource;
    }

    const newUniformId = `${uniformId}_${material._count++}`;
    replacedTokenCount = replaceToken(material, uniformId, newUniformId);
    //>>includeStart('debug', pragmas.debug);
    if (replacedTokenCount === 1 && strict) {
      throw new DeveloperError(
        `strict: shader source does not use uniform '${uniformId}'.`,
      );
    }
    //>>includeEnd('debug');

    // Set uniform value
    material.uniforms[uniformId] = uniformValue;

    if (uniformType === "sampler2D") {
      material._uniforms[newUniformId] = function () {
        return material._textures[uniformId];
      };
      material._updateFunctions.push(createTexture2DUpdateFunction(uniformId));
      material._initializationPromises.push(
        loadTexture2DImageForUniform(material, uniformId),
      );
    } else if (uniformType === "samplerCube") {
      material._uniforms[newUniformId] = function () {
        return material._textures[uniformId];
      };
      material._updateFunctions.push(createCubeMapUpdateFunction(uniformId));
      material._initializationPromises.push(
        loadCubeMapImagesForUniform(material, uniformId),
      );
    } else if (uniformType.includes("mat")) {
      const scratchMatrix = new matrixMap[uniformType]();
      material._uniforms[newUniformId] = function () {
        return matrixMap[uniformType].fromColumnMajorArray(
          material.uniforms[uniformId],
          scratchMatrix,
        );
      };
    } else {
      material._uniforms[newUniformId] = function () {
        return material.uniforms[uniformId];
      };
    }
  }
}

// Determines the uniform type based on the uniform in the template.
function getUniformType(uniformValue) {
  let uniformType = uniformValue.type;
  if (!defined(uniformType)) {
    const type = typeof uniformValue;
    if (type === "number") {
      uniformType = "float";
    } else if (type === "boolean") {
      uniformType = "bool";
    } else if (
      type === "string" ||
      uniformValue instanceof Resource ||
      uniformValue instanceof HTMLCanvasElement ||
      uniformValue instanceof HTMLImageElement ||
      uniformValue instanceof ImageBitmap ||
      uniformValue instanceof OffscreenCanvas
    ) {
      if (/^([rgba]){1,4}$/i.test(uniformValue)) {
        uniformType = "channels";
      } else if (uniformValue === DEFAULT_CUBE_MAP_ID) {
        uniformType = "samplerCube";
      } else {
        uniformType = "sampler2D";
      }
    } else if (type === "object") {
      if (Array.isArray(uniformValue)) {
        if (
          uniformValue.length === 4 ||
          uniformValue.length === 9 ||
          uniformValue.length === 16
        ) {
          uniformType = `mat${Math.sqrt(uniformValue.length)}`;
        }
      } else {
        let numAttributes = 0;
        for (const attribute in uniformValue) {
          if (uniformValue.hasOwnProperty(attribute)) {
            numAttributes += 1;
          }
        }
        if (numAttributes >= 2 && numAttributes <= 4) {
          uniformType = `vec${numAttributes}`;
        } else if (numAttributes === 6) {
          uniformType = "samplerCube";
        }
      }
    }
  }
  return uniformType;
}

// Create all sub-materials by combining source and uniforms together.
function createSubMaterials(material, MaterialConstructor) {
  const strict = material._strict;
  const subMaterialTemplates = material._template.materials;
  for (const subMaterialId in subMaterialTemplates) {
    if (subMaterialTemplates.hasOwnProperty(subMaterialId)) {
      // Construct the sub-material.
      const subMaterial = new MaterialConstructor({
        strict: strict,
        fabric: subMaterialTemplates[subMaterialId],
        count: material._count,
      });

      material._count = subMaterial._count;
      material._uniforms = combine(
        material._uniforms,
        subMaterial._uniforms,
        true,
      );
      material.materials[subMaterialId] = subMaterial;
      material._translucentFunctions = material._translucentFunctions.concat(
        subMaterial._translucentFunctions,
      );

      // Make the material's czm_getMaterial unique by appending the sub-material type.
      const originalMethodName = "czm_getMaterial";
      const newMethodName = `${originalMethodName}_${material._count++}`;
      replaceToken(subMaterial, originalMethodName, newMethodName);
      material.shaderSource = subMaterial.shaderSource + material.shaderSource;

      // Replace each material id with an czm_getMaterial method call.
      const materialMethodCall = `${newMethodName}(materialInput)`;
      const tokensReplacedCount = replaceToken(
        material,
        subMaterialId,
        materialMethodCall,
      );
      //>>includeStart('debug', pragmas.debug);
      if (tokensReplacedCount === 0 && strict) {
        throw new DeveloperError(
          `strict: shader source does not use material '${subMaterialId}'.`,
        );
      }
      //>>includeEnd('debug');
    }
  }
}

// Used for searching or replacing a token in a material's shader source with something else.
// If excludePeriod is true, do not accept tokens that are preceded by periods.
// http://stackoverflow.com/questions/641407/javascript-negative-lookbehind-equivalent
function replaceToken(material, token, newToken, excludePeriod) {
  excludePeriod = excludePeriod ?? true;
  let count = 0;
  const suffixChars = "([\\w])?";
  const prefixChars = `([\\w${excludePeriod ? "." : ""}])?`;
  const regExp = new RegExp(prefixChars + token + suffixChars, "g");
  material.shaderSource = material.shaderSource.replace(
    regExp,
    function ($0, $1, $2) {
      if ($1 || $2) {
        return $0;
      }
      count += 1;
      return newToken;
    },
  );
  return count;
}

function getNumberOfTokens(material, token, excludePeriod) {
  return replaceToken(material, token, token, excludePeriod);
}

/**
 * Initializes a Material instance from fabric options. Sets up the template,
 * shader source, uniforms, and sub-materials.
 *
 * @param {object} options Construction options.
 * @param {Material} result The Material instance to initialize.
 * @param {Function} MaterialConstructor The Material constructor, needed for sub-materials.
 * @private
 */
function initializeMaterial(options, result, MaterialConstructor) {
  options = options ?? Frozen.EMPTY_OBJECT;
  result._strict = options.strict ?? false;
  result._count = options.count ?? 0;
  result._template = clone(options.fabric ?? Frozen.EMPTY_OBJECT);
  result.fabric = clone(options.fabric ?? Frozen.EMPTY_OBJECT);
  result._template.uniforms = clone(
    result._template.uniforms ?? Frozen.EMPTY_OBJECT,
  );
  result._template.materials = clone(
    result._template.materials ?? Frozen.EMPTY_OBJECT,
  );

  result.type = defined(result._template.type)
    ? result._template.type
    : createGuid();

  result.shaderSource = "";
  result.materials = {};
  result.uniforms = {};
  result._uniforms = {};
  result._translucentFunctions = [];

  let translucent;

  // If the cache contains this material type, build the material template off of the stored template.
  const cachedMaterial = materialCache.getMaterial(result.type);
  if (defined(cachedMaterial)) {
    const template = clone(cachedMaterial.fabric, true);
    result._template = combine(result._template, template, true);
    translucent = cachedMaterial.translucent;
  }

  // Make sure the template has no obvious errors. More error checking happens later.
  checkForTemplateErrors(result);

  createMethodDefinition(result);
  createUniforms(result);

  // After createUniforms populates result.uniforms with default values,
  // create a MaterialUniformBuffer backed by Float32Array and replace the
  // plain object with a facade that provides backward-compatible property
  // access while storing numeric values in a packed GPU-ready buffer.
  //
  // The _uniformBuffer field gives WebGPU renderers direct access to the
  // packed data via `material._uniformBuffer.gpuData` for zero-copy upload.
  // The facade ensures existing code (`material.uniforms.color.alpha < 1.0`)
  // continues to work via getter/setter pass-through.
  const uniformBuffer = new MaterialUniformBuffer(result.uniforms);
  result._uniformBuffer = uniformBuffer;
  const facade = uniformBuffer.createFacade();
  // Migrate any texture references that createUniform stored in result.uniforms
  // but that are also used by the _uniforms getter closures.
  const oldUniforms = result.uniforms;
  result.uniforms = facade;
  // The _uniforms getter functions close over `material.uniforms[uniformId]`.
  // Since we replaced result.uniforms with a facade that has the same
  // enumerable properties and getter/setter behavior, the closures continue
  // to work — they read/write through the facade, which routes to the buffer.

  createSubMaterials(result, MaterialConstructor);

  // If the material has a new type, add it to the cache.
  if (!defined(cachedMaterial)) {
    materialCache.addMaterial(result.type, result);
  }

  const defaultTranslucent =
    result._translucentFunctions.length === 0 ? true : undefined;
  translucent = translucent ?? defaultTranslucent;
  translucent = options.translucent ?? translucent;

  if (defined(translucent)) {
    if (typeof translucent === "function") {
      const wrappedTranslucent = function () {
        return translucent(result);
      };
      result._translucentFunctions.push(wrappedTranslucent);
    } else {
      result._translucentFunctions.push(translucent);
    }
  }
}

/**
 * Recursively traverses the material and its submaterials to collect all initialization promises.
 * @param {Material} material The material to traverse.
 * @param {Promise[]} initializationPromises The array to collect promises into.
 *
 * @private
 */
function getInitializationPromises(material, initializationPromises) {
  initializationPromises.push(...material._initializationPromises);
  const submaterials = material.materials;
  for (const name in submaterials) {
    if (submaterials.hasOwnProperty(name)) {
      const submaterial = submaterials[name];
      getInitializationPromises(submaterial, initializationPromises);
    }
  }
}

export {
  DEFAULT_IMAGE_ID,
  DEFAULT_CUBE_MAP_ID,
  materialCache,
  initializeMaterial,
  getInitializationPromises,
};

// Namespace default export for build system barrel compatibility
const MaterialHelpers = {
  DEFAULT_IMAGE_ID,
  DEFAULT_CUBE_MAP_ID,
  materialCache,
  initializeMaterial,
  getInitializationPromises,
};
export default MaterialHelpers;

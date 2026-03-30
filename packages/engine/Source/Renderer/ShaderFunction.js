import DeveloperError from "../Core/DeveloperError.js";

/**
 * A utility for dynamically-generating a GLSL function
 *
 * @alias ShaderFunction
 *
 * @see {@link ShaderBuilder}
 * @param {string} signature The full signature of the function as it will appear in the shader. Do not include the curly braces.
 * @example
 * // generate the following function
 * //
 * // void assignVaryings(vec3 position)
 * // {
 * //    v_positionEC = (czm_modelView * vec4(a_position, 1.0)).xyz;
 * //    v_texCoord = a_texCoord;
 * // }
 * const signature = "void assignVaryings(vec3 position)";
 * const func = new ShaderFunction(signature);
 * func.addLine("v_positionEC = (czm_modelView * vec4(a_position, 1.0)).xyz;");
 * func.addLine("v_texCoord = a_texCoord;");
 * const generatedLines = func.generateGlslLines();
 *
 * @private
 */
class ShaderFunction {
  constructor(signature) {
    this.signature = signature;
    this.body = [];
  }

  /**
   * Adds one or more lines to the body of the function
   * @param {string|string[]} lines One or more lines of GLSL code to add to the function body. Do not include any preceding or trailing whitespace, but do include the semicolon for each line.
   */
  addLines(lines) {
    const body = this.body;
    if (Array.isArray(lines)) {
      const length = lines.length;
      for (let i = 0; i < length; i++) {
        body.push(`    ${lines[i]}`);
      }
    } else {
      body.push(`    ${lines}`);
    }
  }

  /**
   * Generate lines of GLSL code for use with {@link ShaderBuilder}
   * @return {string[]} The generated GLSL lines
   */
  generateGlslLines() {
    //>>includeStart('debug', pragmas.debug);
    if (this.body.length === 0) {
      throw new DeveloperError(
        "The shader function must have at least one line.",
      );
    }
    //>>includeEnd('debug');

    const lines = [];
    lines.push(this.signature);
    lines.push("{");
    const bodyLength = this.body.length;
    for (let i = 0; i < bodyLength; i++) {
      lines.push(this.body[i]);
    }
    lines.push("}");
    lines.push("");
    return lines;
  }
}

export default ShaderFunction;
